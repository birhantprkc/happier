import { createServerUrlComparableKey, type DoctorSnapshot } from '@happier-dev/protocol';

import { resolveActiveServerAuthReadiness } from '@/auth/resolveActiveServerAuthReadiness';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { isDaemonRunningCurrentlyInstalledHappyVersion } from '@/daemon/controlClient';
import { resolveDaemonStartupSourceServiceManagedState } from '@/daemon/ownership/daemonOwnershipMetadata';
import { evaluateCurrentDaemonOwner, type DaemonOwnerEvaluation } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { readDaemonState, readSettings } from '@/persistence';
import { resolveDaemonServiceInstallationSnapshotFromEnv } from '@/daemon/service/cli';

export type DaemonStatusSnapshot = NonNullable<DoctorSnapshot['daemonStatus']>;
export type DaemonRuntimeConvergence = NonNullable<DaemonStatusSnapshot['runtimeConvergence']>;

function resolveComparableKey(rawUrl: string): string | null {
  const value = String(rawUrl ?? '').trim();
  if (!value) {
    return null;
  }
  try {
    return createServerUrlComparableKey(value);
  } catch {
    return null;
  }
}

function readTokenSubject(token: string | null | undefined): string | null {
  if (!token) {
    return null;
  }
  try {
    const payload = decodeJwtPayload(token);
    return typeof payload?.sub === 'string' && payload.sub.trim()
      ? payload.sub.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * What the running daemon is actually doing, as opposed to the files beside it.
 *
 * Liveness is the authenticated control endpoint (never host-visible PID equality),
 * ownership is the canonical owner evaluation, and identity/version are read from the
 * state that evaluation proved live. A daemon left running as one account while another
 * account's credentials were written is therefore reported as not converged.
 */
async function deriveRuntimeConvergence(params: Readonly<{
  expectedMachineId: string | null;
  expectedServiceLabel: string;
  serviceInstalled: boolean;
}>): Promise<DaemonRuntimeConvergence> {
  const evaluation: DaemonOwnerEvaluation = await evaluateCurrentDaemonOwner();
  const runningOwner = evaluation.kind !== 'none' && evaluation.owner.source === 'state' && evaluation.owner.status === 'running'
    ? evaluation.owner
    : null;
  if (!runningOwner) {
    return {
      controlReachable: false,
      serviceOwnsRunningDaemon: false,
      machineIdMatches: false,
      cliVersionMatches: false,
    };
  }

  const runningMachineId = typeof runningOwner.state.machineId === 'string' ? runningOwner.state.machineId.trim() : '';
  const runningServiceLabel = typeof runningOwner.state.serviceLabel === 'string' ? runningOwner.state.serviceLabel.trim() : '';
  return {
    controlReachable: true,
    serviceOwnsRunningDaemon: evaluation.kind === 'compatible'
      && runningOwner.serviceManaged === true
      && params.serviceInstalled
      && runningServiceLabel === params.expectedServiceLabel,
    machineIdMatches: params.expectedMachineId !== null && runningMachineId === params.expectedMachineId,
    cliVersionMatches: await isDaemonRunningCurrentlyInstalledHappyVersion(),
  };
}

export async function readDaemonStatusSnapshot(): Promise<DaemonStatusSnapshot> {
  const [settings, authReadiness, daemonState] = await Promise.all([
    readSettings(),
    resolveActiveServerAuthReadiness(),
    readDaemonState().catch(() => null),
  ]);

  const activeServerId = configuration.activeServerId;
  const activeServer = settings.servers?.[activeServerId];
  const localServerUrl = typeof activeServer?.localServerUrl === 'string' && activeServer.localServerUrl.trim()
    ? activeServer.localServerUrl.trim()
    : null;

  const pid = typeof daemonState?.pid === 'number' ? daemonState.pid : null;
  const machineId = authReadiness.machineId;
  const credentials = authReadiness.credentials;
  const serviceSnapshot = resolveDaemonServiceInstallationSnapshotFromEnv();
  const runtimeConvergence = await deriveRuntimeConvergence({
    expectedMachineId: machineId,
    expectedServiceLabel: serviceSnapshot.label,
    serviceInstalled: serviceSnapshot.installed,
  });
  const daemonRunning = runtimeConvergence.controlReachable;

  return {
    server: {
      activeServerId,
      serverUrl: configuration.serverUrl,
      localServerUrl,
      publicServerUrl: configuration.publicServerUrl,
      webappUrl: configuration.webappUrl,
      comparableKey: resolveComparableKey(configuration.publicServerUrl || configuration.serverUrl),
    },
    daemon: {
      running: daemonRunning,
      pid,
      httpPort: typeof daemonState?.httpPort === 'number' ? daemonState.httpPort : null,
      startedWithCliVersion: typeof daemonState?.startedWithCliVersion === 'string'
        ? daemonState.startedWithCliVersion
        : undefined,
      startedWithPublicReleaseChannel: daemonState?.startedWithPublicReleaseChannel ?? null,
      runtimeId: typeof daemonState?.runtimeId === 'string' ? daemonState.runtimeId : undefined,
      startupSource: typeof daemonState?.startupSource === 'string' ? daemonState.startupSource : undefined,
      serviceManaged: resolveDaemonStartupSourceServiceManagedState(daemonState?.startupSource, daemonState?.serviceLabel),
      serviceLabel: typeof daemonState?.serviceLabel === 'string'
        ? daemonState.serviceLabel
        : null,
    },
    service: {
      installed: serviceSnapshot.installed,
      running: serviceSnapshot.installed && daemonRunning,
      targetMode: serviceSnapshot.targetMode,
      autostart: serviceSnapshot.autostart,
    },
    auth: {
      authenticated: credentials != null,
      machineRegistered: machineId != null,
      machineId,
      needsAuth: credentials == null || machineId == null,
      accountId: readTokenSubject(credentials?.token),
      credentialState: authReadiness.credentialState,
      validatedAccountId: authReadiness.validatedAccountId,
    },
    runtimeConvergence,
  };
}
