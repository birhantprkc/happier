import { systemTasks } from '@happier-dev/cli-common';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { resolveVersionedLocalHappierCli } from '../happierCli.js';
import {
  controlDaemonService,
  type DaemonServiceAutostartMode,
  type DaemonStatusSnapshot,
  isDaemonServiceStarted,
  readDaemonStatus,
  setDaemonServiceAutostart,
  waitForStartedDaemonService,
} from '../localDaemonCli.js';
import { ACCEPTED_BOOTSTRAP_CHANNELS, normalizeBootstrapChannel } from '../taskRuntime.js';

export type DaemonServiceTaskParams = Readonly<{
  target: Readonly<{
    kind: 'local';
  }>;
  /** The app's release ring; selects which managed Happier CLI answers. */
  releaseRing: PublicReleaseRingId;
  surface?: string;
  mode?: 'user';
  /**
   * Only `daemon.service.autostart.set.v1` carries it, and it is never defaulted: the two modes
   * mean opposite things for whether this computer is reachable while the app is closed.
   */
  autostart?: DaemonServiceAutostartMode;
}>;

/**
 * The ambient inspection result. Acquisition is stated explicitly: running this task
 * installs the managed CLI when it is missing, and `acquisition` names the CLI that
 * answered, where it came from, and the version it reports.
 */
type DaemonServiceTaskResult = Readonly<{
  serviceInstalled: boolean;
  daemonRunning: boolean;
  needsAuth: boolean;
  machineId: string | null;
  acquisition: DaemonStatusSnapshot['acquisition'];
  server: DaemonStatusSnapshot['server'];
  auth: DaemonStatusSnapshot['auth'];
  service: DaemonStatusSnapshot['service'];
  daemon: DaemonStatusSnapshot['daemon'];
  runtimeConvergence: DaemonStatusSnapshot['runtimeConvergence'];
}>;

function toDaemonServiceResult(status: DaemonStatusSnapshot): DaemonServiceTaskResult {
  return {
    serviceInstalled: status.serviceInstalled,
    daemonRunning: status.daemonRunning,
    needsAuth: status.needsAuth,
    machineId: status.machineId,
    acquisition: status.acquisition,
    server: status.server,
    auth: status.auth,
    service: status.service,
    daemon: status.daemon,
    runtimeConvergence: status.runtimeConvergence,
  };
}

/** The preconditions `daemon service start` needs before it can start anything. */
function assertDaemonServiceStartable(status: DaemonStatusSnapshot): void {
  if (!status.serviceInstalled) {
    throw new systemTasks.SystemTaskExecutionError(
      'daemon_service_not_installed',
      'Daemon service is not installed on this computer yet.',
    );
  }
  if (status.needsAuth) {
    throw new systemTasks.SystemTaskExecutionError(
      'not_authenticated',
      'Authenticate this computer with the selected Relay before continuing.',
    );
  }
}

export function createDaemonServiceStatusHandler() {
  return async function* (
    params: unknown,
    _context: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<never, DaemonServiceTaskResult, void> {
    const parsed = parseDaemonServiceParams(params);
    const status = await readDaemonStatus(parsed.releaseRing);
    return toDaemonServiceResult(status);
  };
}

export function createDaemonServiceStartHandler() {
  return async function* (
    params: unknown,
    context: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<Readonly<{ type: 'progress'; stepId: string; message?: string }>, DaemonServiceTaskResult, void> {
    const parsed = parseDaemonServiceParams(params);
    yield {
      type: 'progress',
      stepId: 'task.step.prepare',
      message: 'Inspect daemon service',
    };

    // One acquisition and one version read for the whole run, including the readiness re-reads.
    const cli = await resolveVersionedLocalHappierCli({ releaseRing: parsed.releaseRing });
    const currentStatus = await readDaemonStatus(parsed.releaseRing, cli);
    assertDaemonServiceStartable(currentStatus);

    yield {
      type: 'progress',
      stepId: 'task.step.installRuntime',
      message: 'Start daemon service',
    };

    await controlDaemonService(parsed.releaseRing, { action: 'start', takeover: false }, cli);

    const startedStatus = await waitForStartedDaemonService({
      readDaemonStatus: () => readDaemonStatus(parsed.releaseRing, cli),
      signal: context.signal,
    });
    if (!isDaemonServiceStarted(startedStatus)) {
      throw new systemTasks.SystemTaskExecutionError(
        'daemon_service_not_ready',
        'Daemon service did not reach a ready state.',
      );
    }

    yield {
      type: 'progress',
      stepId: 'task.step.finish',
      message: 'Daemon service started',
    };

    return toDaemonServiceResult(startedStatus);
  };
}

/**
 * Desktop closes: with login start off the app stops the background service as it quits, so the
 * computer does not keep answering for an app the user has closed. The stop itself belongs to the
 * CLI; this handler sequences it and then proves it by re-reading, never by the command's success.
 */
export function createDaemonServiceStopHandler() {
  return async function* (
    params: unknown,
    _context: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<Readonly<{ type: 'progress'; stepId: string; message?: string }>, DaemonServiceTaskResult, void> {
    const parsed = parseDaemonServiceParams(params);
    yield {
      type: 'progress',
      stepId: 'task.step.prepare',
      message: 'Stop daemon service',
    };

    // One acquisition and one version read for the whole run: the command that stops the service
    // and the read that proves it stopped must be the same CLI.
    const cli = await resolveVersionedLocalHappierCli({ releaseRing: parsed.releaseRing });
    await controlDaemonService(parsed.releaseRing, { action: 'stop', takeover: false }, cli);

    const status = await readDaemonStatus(parsed.releaseRing, cli);
    if (status.daemonRunning || status.service.running) {
      throw new systemTasks.SystemTaskExecutionError(
        'daemon_service_still_running',
        'The background service is still running after the stop command.',
      );
    }

    yield {
      type: 'progress',
      stepId: 'task.step.finish',
      message: 'Daemon service stopped',
    };

    return toDaemonServiceResult(status);
  };
}

/**
 * Whether the installed service starts at login. The CLI owns every platform rule; this handler
 * states the intent and re-reads the installed definition, so a CLI that cannot express the mode
 * fails by name instead of leaving the toggle claiming something the computer will not do.
 */
export function createDaemonServiceAutostartSetHandler() {
  return async function* (
    params: unknown,
    _context: Readonly<{ signal: AbortSignal }>,
  ): AsyncGenerator<Readonly<{ type: 'progress'; stepId: string; message?: string }>, DaemonServiceTaskResult, void> {
    const parsed = parseDaemonServiceAutostartParams(params);
    yield {
      type: 'progress',
      stepId: 'task.step.prepare',
      message: parsed.autostart === 'at-login'
        ? 'Start the background service at login'
        : 'Stop starting the background service at login',
    };

    const cli = await resolveVersionedLocalHappierCli({ releaseRing: parsed.releaseRing });
    await setDaemonServiceAutostart(parsed.releaseRing, parsed.autostart, cli);

    const status = await readDaemonStatus(parsed.releaseRing, cli);
    if (status.service.autostart === null) {
      throw new systemTasks.SystemTaskExecutionError(
        'daemon_service_autostart_unsupported',
        'The installed Happier CLI does not report the background service autostart mode.',
      );
    }
    if (status.service.autostart !== parsed.autostart) {
      throw new systemTasks.SystemTaskExecutionError(
        'daemon_service_autostart_not_applied',
        'The installed background service still declares a different autostart mode than requested.',
      );
    }

    yield {
      type: 'progress',
      stepId: 'task.step.finish',
      message: 'Login start updated',
    };

    return toDaemonServiceResult(status);
  };
}

export function parseDaemonServiceParams(params: unknown): DaemonServiceTaskParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Daemon service params must be an object.');
  }
  const record = params as Record<string, unknown>;
  const target = record.target;
  const mode = record.mode;

  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'target is required.');
  }
  const targetRecord = target as Record<string, unknown>;
  const kind = typeof targetRecord.kind === 'string' ? targetRecord.kind.trim() : '';
  if (kind !== 'local') {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'Only local daemon targets are supported.');
  }

  const normalizedMode = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  if (normalizedMode && normalizedMode !== 'user') {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'mode must be "user" when provided.');
  }

  const surface = record.surface;
  if (surface !== undefined && (typeof surface !== 'string' || surface.trim().length === 0)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'surface must be a non-empty string when provided.');
  }

  const autostart = record.autostart;
  if (autostart !== undefined && autostart !== 'at-login' && autostart !== 'on-demand') {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'autostart must be at-login or on-demand when provided.');
  }

  return {
    target: {
      kind: 'local',
    },
    releaseRing: parseBootstrapChannelParam(record.channel),
    ...(surface === undefined ? {} : { surface: surface.trim() }),
    ...(normalizedMode === 'user' ? { mode: 'user' as const } : {}),
    ...(autostart === undefined ? {} : { autostart }),
  };
}

/**
 * The ring the caller asked for, or a failure. `normalizeBootstrapChannel` maps anything it does
 * not recognise to `stable`, which would read or start the wrong ring's CLI for a typo'd ring —
 * the same reason `parseSetupThisComputerParams` rejects one. An absent channel keeps the default.
 */
function parseBootstrapChannelParam(value: unknown): PublicReleaseRingId {
  if (value === undefined || value === null) {
    return normalizeBootstrapChannel(undefined).releaseChannel;
  }
  const channel = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!ACCEPTED_BOOTSTRAP_CHANNELS.includes(channel)) {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_params',
      `channel must be one of ${ACCEPTED_BOOTSTRAP_CHANNELS.join(', ')} when provided.`,
    );
  }
  return normalizeBootstrapChannel(channel).releaseChannel;
}

/**
 * The autostart sibling shares the family parser and adds the one field that must not be
 * defaulted. A missing `autostart` is a caller bug, not "leave it off".
 */
export function parseDaemonServiceAutostartParams(
  params: unknown,
): DaemonServiceTaskParams & Readonly<{ autostart: DaemonServiceAutostartMode }> {
  const parsed = parseDaemonServiceParams(params);
  if (parsed.autostart === undefined) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'autostart is required.');
  }
  return { ...parsed, autostart: parsed.autostart };
}
