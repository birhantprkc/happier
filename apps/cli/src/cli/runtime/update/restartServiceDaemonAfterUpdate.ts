import { spawnSync } from 'node:child_process';

import { resolveInstalledFirstPartyComponentPaths, resolveManagedCliToolNameForRing } from '@happier-dev/cli-common/firstPartyRuntime';
import { getReleaseRingCatalogEntry, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { evaluateCurrentDaemonOwner, type DaemonOwnerEvaluation } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } from '@/daemon/service/cli';
import type { DaemonServiceTargetMode } from '@/daemon/service/plan';

/**
 * What an update does about the background service's daemon, decided from the owner observed
 * BEFORE the update (on Windows the update stops the payload's processes first, so only that
 * earlier observation still knows the service's daemon was running and must come back).
 *
 * Only a daemon this channel's own background service started is restarted (plan R10 D2, R13 S-8):
 * a manual daemon and another channel's service are left alone, and a service label this CLI does
 * not manage is named, never guessed at.
 */
export type ServiceDaemonRestartPlan = Readonly<
  | { kind: 'restart'; channel: PublicReleaseRingId; targetMode: DaemonServiceTargetMode; instanceId: string }
  | { kind: 'skip'; reason: 'not-running' | 'not-service-managed' | 'other-channel' }
  | { kind: 'unmanaged'; message: string }
>;

const SERVICE_TARGET_MODES: readonly DaemonServiceTargetMode[] = ['default-following', 'pinned'];

function restartCommandFor(channel: PublicReleaseRingId): string {
  return `${resolveManagedCliToolNameForRing(channel)} service restart`;
}

export function planServiceDaemonRestartAfterUpdate(params: Readonly<{
  channel: PublicReleaseRingId;
  ownerBeforeUpdate: DaemonOwnerEvaluation;
  processEnv?: NodeJS.ProcessEnv;
}>): ServiceDaemonRestartPlan {
  const processEnv = params.processEnv ?? process.env;
  const ownership = params.ownerBeforeUpdate;
  if (ownership.kind === 'none') {
    return { kind: 'skip', reason: 'not-running' };
  }
  const { owner } = ownership;
  if (owner.serviceManaged !== true) {
    return { kind: 'skip', reason: 'not-service-managed' };
  }
  const ownerChannel = owner.state.startedWithPublicReleaseChannel ?? null;
  if (ownerChannel !== null && ownerChannel !== getReleaseRingCatalogEntry(params.channel).publicLabel) {
    return { kind: 'skip', reason: 'other-channel' };
  }

  const serviceLabel = String(owner.state.serviceLabel ?? '').trim();
  const service = SERVICE_TARGET_MODES
    .map((targetMode) => {
      const runtime = resolveDaemonServiceCliRuntimeFromEnv({ channel: params.channel, targetMode, processEnv });
      return { targetMode, instanceId: runtime.instanceId, label: resolveDaemonServicePaths(runtime).label };
    })
    .find((candidate) => serviceLabel !== '' && candidate.label === serviceLabel);
  if (!service) {
    return {
      kind: 'unmanaged',
      message: `The running background service (${serviceLabel || 'unknown label'}) is not one this CLI manages. Run: ${restartCommandFor(params.channel)}`,
    };
  }
  return { kind: 'restart', channel: params.channel, targetMode: service.targetMode, instanceId: service.instanceId };
}

/**
 * Restart the planned service daemon onto the CLI the channel's `current` names now, through the
 * CLI service owner run BY THAT CLI (`<current>/happier daemon service restart`): only its own
 * ownership wait accepts its version as the owner, and that wait is the whole time budget. Then
 * the owner is re-read and must run `expectedVersion`. Throws when either is not proven — the
 * update transaction then restores the previous version and calls this again for it.
 */
export async function restartServiceDaemonOntoInstalledCli(params: Readonly<{
  plan: Extract<ServiceDaemonRestartPlan, { kind: 'restart' }>;
  expectedVersion: string;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<void> {
  const processEnv = params.processEnv ?? process.env;
  const { channel } = params.plan;
  const binaryPath = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-cli',
    channel,
    processEnv,
  }).binaryPath;
  const result = spawnSync(binaryPath, ['daemon', 'service', 'restart'], {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...processEnv,
      HAPPIER_DAEMON_SERVICE_CHANNEL: channel,
      HAPPIER_PUBLIC_RELEASE_CHANNEL: getReleaseRingCatalogEntry(channel).publicLabel,
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: params.plan.targetMode,
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: params.plan.instanceId,
    },
  });
  if (result.status !== 0) {
    const detail = result.error instanceof Error ? result.error.message : `exit status ${result.status ?? 'unknown'}`;
    throw new Error(`the background service did not come back on ${params.expectedVersion} (${detail})`);
  }

  const ownership = await evaluateCurrentDaemonOwner();
  const runningVersion = ownership.kind === 'none' ? null : ownership.owner.state.startedWithCliVersion ?? null;
  if (runningVersion !== params.expectedVersion) {
    throw new Error(`the background service runs ${runningVersion ?? 'no daemon'} instead of ${params.expectedVersion}`);
  }
}
