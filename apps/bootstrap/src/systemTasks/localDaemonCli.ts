import { systemTasks } from '@happier-dev/cli-common';
import { DoctorSnapshotDaemonStatusSchema, type DoctorSnapshotDaemonStatus } from '@happier-dev/protocol';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import {
  resolveVersionedLocalHappierCli,
  runLocalHappierJsonCommand,
  type SetupCapableLocalHappierCli,
} from './happierCli.js';
import type { LocalFirstPartyCommandProvenance } from './localFirstPartyCommand.js';

export type RelayProfileTarget = Readonly<{
  serverUrl: string;
  webappUrl: string;
  localServerUrl: string | null;
}>;

export type ConfiguredRelay = Readonly<{
  serverUrl: string;
  comparableKey: string;
}>;

export type AuthStatusSnapshot = Readonly<{
  authenticated: boolean;
  accountId: string | null;
  machineId: string | null;
}>;

export type DaemonCredentialState = 'missing' | 'rejected' | 'valid' | 'unknown';

/**
 * Whether the installed background service follows the default relay or is pinned to one relay
 * profile — the CLI's own vocabulary (`DaemonServiceTargetMode`). A reader that cannot see this
 * cannot tell "a service is installed" apart from "a service this app may repoint on its own".
 */
export type DaemonServiceTargetMode = 'pinned' | 'default-following';

/**
 * Whether the installed background service starts the daemon at login — the CLI's own
 * `DaemonServiceAutostartMode` vocabulary (`apps/cli/src/daemon/service/plan.ts`), not a boolean.
 * A boolean cannot express UNKNOWN, and this seam needs unknown: a CLI that reports no mode must
 * not be read as "off" and taken off the air, nor as "on" and claimed available.
 */
export type DaemonServiceAutostartMode = 'at-login' | 'on-demand';

/**
 * What the running daemon is doing, as the CLI derived it from its authenticated control
 * endpoint and owner evaluation. `null` when the CLI that answered predates the block.
 */
export type DaemonRuntimeConvergence = Readonly<{
  controlReachable: boolean;
  serviceOwnsRunningDaemon: boolean;
  machineIdMatches: boolean;
  cliVersionMatches: boolean;
}>;

/**
 * The ambient inspection. The flat fields are the long-standing summary; the nested blocks
 * carry every fact `happier daemon status --json` emitted, plus which CLI answered.
 */
export type DaemonStatusSnapshot = Readonly<{
  serviceInstalled: boolean;
  daemonRunning: boolean;
  needsAuth: boolean;
  machineId: string | null;
  serverComparableKey: string | null;
  acquisition: Readonly<{
    command: string;
    provenance: LocalFirstPartyCommandProvenance;
    /** The version that CLI reports for itself, so a reader can tell which contract answered. */
    version: string;
  }>;
  server: Readonly<{
    activeServerId: string | null;
    serverUrl: string | null;
    publicServerUrl: string | null;
    localServerUrl: string | null;
    comparableKey: string | null;
  }>;
  auth: Readonly<{
    authenticated: boolean;
    machineRegistered: boolean;
    machineId: string | null;
    needsAuth: boolean;
    accountId: string | null;
    credentialState: DaemonCredentialState | null;
    validatedAccountId: string | null;
  }>;
  service: Readonly<{
    installed: boolean;
    running: boolean;
    /** `null` when nothing proved a mode — an older CLI, or no readable definition. Never a default. */
    targetMode: DaemonServiceTargetMode | null;
    /**
     * The autostart mode the installed definition declares. `null` when the CLI that answered
     * does not report one, so a desktop toggle shows "unknown" instead of claiming the user's
     * computer will stop answering after they close the app.
     */
    autostart: DaemonServiceAutostartMode | null;
  }>;
  daemon: Readonly<{
    running: boolean;
    startedWithCliVersion: string | null;
    serviceManaged: boolean | null;
    serviceLabel: string | null;
  }>;
  runtimeConvergence: DaemonRuntimeConvergence | null;
}>;

export type AuthPairingRequest = Readonly<{
  publicKey: string;
  publicKeyB64Url: string;
  pairingRequirement: string;
}>;

export type AuthPairingClaim = Readonly<{
  machineId: string | null;
}>;

/**
 * The structured answer of `happier daemon service install --dry-run --json` (the `service …`
 * alias runs the same command), as bootstrap consumes it. Every ownership/conflict decision stays
 * inside the CLI: bootstrap only reads whether the intended apply would take over a manual daemon
 * or replace competing services (consent), or is blocked outright.
 */
export type ServiceInstallPreview = Readonly<{
  takeover: string | null;
  installConflict: Readonly<{
    blocking: boolean;
    message: string;
    competingServices: readonly string[];
    servicesToRemove: readonly string[];
  }> | null;
}>;

export type ServiceInstallApplyFlags = Readonly<{
  replaceExisting: boolean;
  takeover: boolean;
}>;

const DEFAULT_DAEMON_READY_TIMEOUT_MS = 15_000;
const DEFAULT_DAEMON_READY_POLL_MS = 500;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * A boolean the CLI's JSON contract has always emitted. Coercing a missing or wrongly typed one to
 * `false` would read corrupt output as "no service, no daemon, no credentials" — the state setup
 * answers by installing and re-pairing — so the value is required rather than defaulted.
 */
function readRequiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_cli_response',
      `CLI response is missing a boolean "${field}".`,
    );
  }
  return value;
}

export async function readAuthStatus(
  releaseRing: PublicReleaseRingId,
  cli?: SetupCapableLocalHappierCli,
): Promise<AuthStatusSnapshot> {
  const parsed = await runLocalHappierJsonCommand({
    args: ['auth', 'status', '--json'],
    releaseRing,
    allowJsonFailure: true,
    cli,
  });
  if (!parsed || typeof parsed !== 'object') {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid auth status response.');
  }

  const record = parsed as {
    ok?: boolean;
    error?: { code?: unknown };
    data?: {
      authenticated?: unknown;
      accountId?: unknown;
      machineId?: unknown;
    };
  };

  if (record.ok === false) {
    const errorCode = typeof record.error?.code === 'string' ? record.error.code.trim() : '';
    if (errorCode === 'not_authenticated') {
      return {
        authenticated: false,
        accountId: null,
        machineId: null,
      };
    }
    throw new systemTasks.SystemTaskExecutionError(
      errorCode || 'auth_status_unavailable',
      'Could not determine authentication status for the selected Relay.',
    );
  }

  // Not defaulted to "not authenticated": the executor answers that state by requesting a pairing
  // and claiming it with `--replace-existing`, which rewrites credentials and restarts the daemon.
  const authenticated = readRequiredBoolean(record.data?.authenticated, 'data.authenticated');
  const accountId = readNonEmptyString(record.data?.accountId);
  if (authenticated && !accountId) {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_cli_response',
      'Auth status reported authenticated credentials without the account they belong to.',
    );
  }

  return {
    authenticated,
    accountId,
    machineId: readNonEmptyString(record.data?.machineId),
  };
}

export async function configureRelay(
  releaseRing: PublicReleaseRingId,
  profile: RelayProfileTarget,
  cli?: SetupCapableLocalHappierCli,
): Promise<ConfiguredRelay> {
  const parsed = await runLocalHappierJsonCommand({
    args: [
      'server',
      'set',
      '--server-url',
      profile.serverUrl,
      ...(profile.localServerUrl ? ['--local-server-url', profile.localServerUrl] : []),
      '--webapp-url',
      profile.webappUrl,
      '--json',
    ],
    releaseRing,
    cli,
  });
  const active = parsed && typeof parsed === 'object'
    ? (parsed as { data?: { active?: { serverUrl?: unknown; comparableKey?: unknown } } }).data?.active
    : undefined;
  const serverUrl = readNonEmptyString(active?.serverUrl);
  const comparableKey = readNonEmptyString(active?.comparableKey);
  if (!serverUrl || !comparableKey) {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid server set response.');
  }
  return { serverUrl, comparableKey };
}

export async function requestAuthPairing(
  releaseRing: PublicReleaseRingId,
  cli?: SetupCapableLocalHappierCli,
): Promise<AuthPairingRequest> {
  const parsed = await runLocalHappierJsonCommand({ args: ['auth', 'request', '--json'], releaseRing, cli });
  const record = parsed && typeof parsed === 'object'
    ? (parsed as { publicKey?: unknown; publicKeyB64Url?: unknown; pairingRequirement?: unknown })
    : {};
  const publicKey = readNonEmptyString(record.publicKey);
  const publicKeyB64Url = readNonEmptyString(record.publicKeyB64Url);
  const pairingRequirement = readNonEmptyString(record.pairingRequirement);
  if (!publicKey || !publicKeyB64Url || !pairingRequirement) {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid auth request response.');
  }
  return { publicKey, publicKeyB64Url, pairingRequirement };
}

export async function waitForAuthPairing(
  releaseRing: PublicReleaseRingId,
  params: Readonly<{ publicKey: string; replaceExisting: boolean }>,
  cli?: SetupCapableLocalHappierCli,
): Promise<AuthPairingClaim> {
  let parsed: unknown;
  try {
    parsed = await runLocalHappierJsonCommand({
      args: [
        'auth',
        'wait',
        '--public-key',
        params.publicKey,
        ...(params.replaceExisting ? ['--replace-existing'] : []),
        '--json',
      ],
      releaseRing,
      cli,
    });
  } catch (error) {
    if (error instanceof systemTasks.SystemTaskExecutionError && error.code === 'cli_command_timeout') {
      throw new systemTasks.SystemTaskExecutionError(
        'pairing_claim_timeout',
        'The approved pairing was not claimed in time. Run setup again to retry.',
      );
    }
    throw error;
  }
  const machineId = parsed && typeof parsed === 'object'
    ? readNonEmptyString((parsed as { machineId?: unknown }).machineId)
    : null;
  return { machineId };
}

function readServiceLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (entry && typeof entry === 'object' ? readNonEmptyString((entry as { label?: unknown }).label) : null))
    .filter((label): label is string => label !== null);
}

/**
 * The one argv for `daemon service install` — the CLI's idempotent convergence command, which is
 * also how the autostart mode is applied. A second builder would let the two drift in the flags
 * they pass to the same command.
 */
function buildServiceInstallArgs(params: Readonly<{
  flags?: ServiceInstallApplyFlags;
  autostart?: DaemonServiceAutostartMode;
}> = {}): string[] {
  return [
    'daemon',
    'service',
    'install',
    ...(params.flags?.replaceExisting ? ['--yes', '--replace-existing=all'] : []),
    ...(params.flags?.takeover ? ['--takeover'] : []),
    ...(params.autostart ? [`--autostart=${params.autostart}`] : []),
    '--json',
  ];
}

/**
 * Preview the most complete apply desktop setup may perform (replace competing services, take
 * over a manual daemon). Each of those effects only appears in the response when the CLI would
 * actually perform it, so the response tells the executor exactly what needs consent.
 */
export async function previewServiceInstall(
  releaseRing: PublicReleaseRingId,
  cli?: SetupCapableLocalHappierCli,
): Promise<ServiceInstallPreview> {
  const parsed = await runLocalHappierJsonCommand({
    args: [...buildServiceInstallArgs({ flags: { replaceExisting: true, takeover: true } }), '--dry-run'],
    releaseRing,
    allowJsonFailure: true,
    cli,
  });
  if (!parsed || typeof parsed !== 'object') {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid service install preview.');
  }
  const record = parsed as {
    ok?: unknown;
    error?: unknown;
    message?: unknown;
    plan?: unknown;
    takeover?: unknown;
    installConflict?: {
      blocking?: unknown;
      message?: unknown;
      competingServices?: unknown;
      servicesToRemove?: unknown;
    } | null;
  };
  if (record.ok === false) {
    throw new systemTasks.SystemTaskExecutionError(
      readNonEmptyString(record.error) ?? 'service_install_blocked',
      readNonEmptyString(record.message) ?? 'The background service cannot be installed on this computer right now.',
    );
  }
  if (!record.plan || typeof record.plan !== 'object') {
    throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid service install preview.');
  }

  const conflict = record.installConflict;
  if (conflict !== undefined && conflict !== null) {
    if (typeof conflict !== 'object' || typeof conflict.blocking !== 'boolean' || !readNonEmptyString(conflict.message)) {
      throw new systemTasks.SystemTaskExecutionError('invalid_cli_response', 'Received an invalid service install conflict description.');
    }
  }

  return {
    takeover: readNonEmptyString(record.takeover),
    installConflict: conflict
      ? {
          blocking: conflict.blocking === true,
          message: String(conflict.message).trim(),
          competingServices: readServiceLabels(conflict.competingServices),
          servicesToRemove: readServiceLabels(conflict.servicesToRemove),
        }
      : null,
  };
}

export async function installService(
  releaseRing: PublicReleaseRingId,
  flags: ServiceInstallApplyFlags,
  cli?: SetupCapableLocalHappierCli,
): Promise<void> {
  await runLocalHappierJsonCommand({ args: buildServiceInstallArgs({ flags }), releaseRing, cli });
}

/**
 * The one invoker of the service lifecycle verbs. `stop` joined `start`/`restart` when desktop
 * gained a background-service toggle: with login start off the app stops the daemon as it quits,
 * and it must stop it through the same command the CLI already owns rather than a second path.
 */
export async function controlDaemonService(
  releaseRing: PublicReleaseRingId,
  params: Readonly<{ action: 'start' | 'stop' | 'restart'; takeover: boolean }>,
  cli?: SetupCapableLocalHappierCli,
): Promise<void> {
  await runLocalHappierJsonCommand({
    args: ['daemon', 'service', params.action, ...(params.takeover ? ['--takeover'] : []), '--json'],
    releaseRing,
    cli,
  });
}

/**
 * The autostart mode of the installed service, expressed through the command that already owns
 * the service definition (`install` is the CLI's idempotent convergence path) and through the
 * flag that command parses. Bootstrap states the intent and re-reads the result; every platform
 * rule stays inside the CLI (INV9).
 */
export async function setDaemonServiceAutostart(
  releaseRing: PublicReleaseRingId,
  autostart: DaemonServiceAutostartMode,
  cli?: SetupCapableLocalHappierCli,
): Promise<void> {
  await runLocalHappierJsonCommand({
    args: buildServiceInstallArgs({ autostart }),
    releaseRing,
    cli,
  });
}

/**
 * `happier daemon status --json` prints exactly the doctor snapshot's daemon-status block
 * (`readDaemonStatusSnapshot` is typed from it), so the protocol schema that already owns that
 * wire shape is the parser. One validation, one failure behaviour: corrupt output fails by field
 * name instead of degrading into "no service, no daemon, not authenticated" — the facts that make
 * the app start an installing, re-pairing setup run.
 *
 * Every released 0.2 CLI emits this shape; the fields added since (targetMode, autostart,
 * credentialState, validatedAccountId, runtimeConvergence) are optional in the schema, so an older
 * CLI parses and reports them as unknown.
 */
function parseDaemonStatusResponse(parsed: unknown): DoctorSnapshotDaemonStatus {
  const result = DoctorSnapshotDaemonStatusSchema.safeParse(parsed);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  const field = issue?.path.join('.') ?? '';
  throw new systemTasks.SystemTaskExecutionError(
    'invalid_cli_response',
    field
      ? `Daemon status response is invalid at "${field}": ${issue?.message ?? 'unexpected value'}.`
      : 'Received an invalid daemon status response.',
  );
}

/**
 * The ambient inspection. `cli` is the CLI a caller already resolved; pass it when the same caller
 * reads status more than once so the acquisition and version read happen once for that run.
 *
 * Absent optional facts are projected to `null` rather than left off: the result crosses to the
 * app, where "the CLI that answered proved no mode" has to be a value a reader can see.
 */
export async function readDaemonStatus(
  releaseRing: PublicReleaseRingId,
  cli?: SetupCapableLocalHappierCli,
): Promise<DaemonStatusSnapshot> {
  const resolvedCli = cli ?? await resolveVersionedLocalHappierCli({ releaseRing });
  const parsed = await runLocalHappierJsonCommand({ args: ['daemon', 'status', '--json'], releaseRing, cli: resolvedCli });
  const status = parseDaemonStatusResponse(parsed);

  return {
    serviceInstalled: status.service.installed,
    daemonRunning: status.daemon.running,
    needsAuth: status.auth.needsAuth,
    machineId: status.auth.machineId,
    serverComparableKey: status.server.comparableKey,
    acquisition: { command: resolvedCli.command, provenance: resolvedCli.provenance, version: resolvedCli.version },
    server: {
      activeServerId: status.server.activeServerId,
      serverUrl: status.server.serverUrl,
      publicServerUrl: status.server.publicServerUrl,
      localServerUrl: status.server.localServerUrl,
      comparableKey: status.server.comparableKey,
    },
    auth: {
      authenticated: status.auth.authenticated,
      machineRegistered: status.auth.machineRegistered,
      machineId: status.auth.machineId,
      needsAuth: status.auth.needsAuth,
      accountId: status.auth.accountId,
      credentialState: status.auth.credentialState ?? null,
      validatedAccountId: status.auth.validatedAccountId ?? null,
    },
    service: {
      installed: status.service.installed,
      running: status.service.running,
      targetMode: status.service.targetMode ?? null,
      autostart: status.service.autostart ?? null,
    },
    daemon: {
      running: status.daemon.running,
      startedWithCliVersion: status.daemon.startedWithCliVersion ?? null,
      serviceManaged: status.daemon.serviceManaged ?? null,
      serviceLabel: status.daemon.serviceLabel ?? null,
    },
    runtimeConvergence: status.runtimeConvergence ?? null,
  };
}

/**
 * What starting the background service can prove about itself: a service is installed, its daemon
 * answers, and credentials for the configured relay are present.
 *
 * This is deliberately NOT "this computer is ready". Desktop readiness is the CLI-derived
 * `runtimeConvergence` block plus the app's own reachability proof (INV8/INV10) — it also requires
 * that the installed service owns the running daemon, that the machine id and CLI version match,
 * and that the machine answers an RPC. These three flat fields cannot establish any of that, so
 * they are named after the command that produces them and nothing reads them as readiness.
 */
export function isDaemonServiceStarted(status: DaemonStatusSnapshot): boolean {
  return status.serviceInstalled && status.daemonRunning && !status.needsAuth;
}

export async function waitForStartedDaemonService(params: Readonly<{
  readDaemonStatus: () => Promise<DaemonStatusSnapshot>;
  signal: AbortSignal;
}>): Promise<DaemonStatusSnapshot> {
  const timeoutMs = readPositiveIntEnv(
    'HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_TIMEOUT_MS',
    DEFAULT_DAEMON_READY_TIMEOUT_MS,
    { min: 100, max: 120_000 },
  );
  const pollMs = readPositiveIntEnv(
    'HAPPIER_BOOTSTRAP_SETUP_THIS_COMPUTER_SERVICE_READY_POLL_MS',
    DEFAULT_DAEMON_READY_POLL_MS,
    { min: 50, max: 5_000 },
  );

  const deadline = Date.now() + timeoutMs;
  let latest = await params.readDaemonStatus();
  while (!isDaemonServiceStarted(latest) && Date.now() < deadline) {
    await delay(pollMs, params.signal);
    latest = await params.readDaemonStatus();
  }
  return latest;
}

function readPositiveIntEnv(
  envVarName: string,
  fallback: number,
  bounds: Readonly<{ min: number; max: number }>,
): number {
  const rawValue = process.env[envVarName];
  const parsed = typeof rawValue === 'string' ? Number.parseInt(rawValue.trim(), 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < bounds.min) {
    return fallback;
  }
  return Math.min(parsed, bounds.max);
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.');
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abortHandler);
      resolve();
    }, ms);
    const abortHandler = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abortHandler);
      reject(new systemTasks.SystemTaskExecutionError('cancelled', 'System task execution was cancelled.'));
    };
    signal.addEventListener('abort', abortHandler, { once: true });
  });
}
