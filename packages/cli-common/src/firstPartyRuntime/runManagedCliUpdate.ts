import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';

import { CliUpdateLastResultSchema, type CliUpdateLastResult, type CliUpdateOutcome } from '@happier-dev/protocol';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { joinPathForPathShape } from '../path/pathShape.js';
import type { FirstPartyAcquisitionOptions } from './acquisitionProgress.js';
import { getFirstPartyComponentCatalogEntry } from './componentCatalog.js';
import { resolveFirstPartyInstallLayout, type FirstPartyInstallLayout } from './installLayout.js';
import { activateVersionedPayload, pruneInstalledVersionsAfterActivation } from './installVersionedPayload.js';
import {
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  type PreparedFirstPartyComponentPayload,
} from './prepareFirstPartyComponentPayloadFromGitHubRelease.js';
import {
  captureInstalledPayloadStateForActivation,
  discardInstalledPayloadStateSnapshot,
  restoreInstalledPayloadState,
} from './restoreInstalledPayloadState.js';
import { readInstalledVersionMarkers } from './versionMarkers.js';
import { withFirstPartyPayloadMutationLock } from './withFirstPartyPayloadMutationLock.js';

const COMPONENT_ID = 'happier-cli' as const;
const LAST_UPDATE_FILE_NAME = 'last-update.json';

/**
 * Restart the background service's daemon onto whatever `current` names now, and prove it runs
 * `expectedVersion` — through the CLI service owner (`daemon service restart`, whose ownership wait
 * is the budget). Throws when that is not proven. `phase` says which binary that is: the activated
 * one, or the previous one after a restore.
 */
export type ManagedCliUpdateRestart = (params: Readonly<{
  expectedVersion: string;
  phase: 'activated' | 'restored';
}>) => Promise<void>;

export type ManagedCliUpdateParams = FirstPartyAcquisitionOptions & Readonly<{
  channel: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
  /** An exact version to install; otherwise the ring's newest release. Resolved once. */
  targetVersion?: string;
  /** Reads the version an executable reports (`<command> --version`), within the caller's process budget. */
  readVersion: (command: string) => Promise<string | null>;
  /**
   * `null` when the background service's own daemon was not running before the update: nothing is
   * restarted then, and nothing is started.
   */
  restartServiceDaemon: ManagedCliUpdateRestart | null;
  /** Runs under the install lock right before activation (Windows `self update` stops the payload's processes). */
  beforeActivate?: () => Promise<void>;
  /** The release acquisition (download + minisign verification + unpack). */
  preparePayload?: (params: FirstPartyAcquisitionOptions & Readonly<{
    componentId: typeof COMPONENT_ID;
    channel: PublicReleaseRingId;
    versionId?: string;
  }>) => Promise<Pick<PreparedFirstPartyComponentPayload, 'versionId' | 'payloadRoot' | 'cleanup'>>;
}>;

export type ManagedCliUpdateResult = Readonly<
  | {
    outcome: 'succeeded';
    previousVersion: string | null;
    targetVersion: string;
    /** Whether the service daemon was restarted onto (and proved to run) the target. */
    restarted: boolean;
    /** `false` when the target was already the installed version. */
    changed: boolean;
  }
  | { outcome: 'rolledBack'; previousVersion: string; targetVersion: string; message: string }
  | { outcome: 'failed'; previousVersion: string | null; targetVersion: string; message: string }
>;

/** A refusal before anything was activated. */
export class ManagedCliUpdateError extends Error {
  constructor(
    readonly code: 'cli_update_smoke_failed',
    message: string,
    readonly targetVersion: string,
  ) {
    super(message);
    this.name = 'ManagedCliUpdateError';
  }
}

function describeError(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map(describeError).join('; ') || error.message;
  }
  return error instanceof Error && error.message.trim() ? error.message.trim() : String(error);
}

function resolveLastUpdatePath(layout: FirstPartyInstallLayout): string {
  return joinPathForPathShape(layout.installRoot, LAST_UPDATE_FILE_NAME);
}

/** The last update attempt's outcome for a ring's managed CLI (`<installRoot>/last-update.json`). */
export function readLastCliUpdateResult(params: Readonly<{
  channel: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): CliUpdateLastResult | null {
  const layout = resolveFirstPartyInstallLayout({ componentId: COMPONENT_ID, channel: params.channel, processEnv: params.processEnv });
  try {
    const parsed = CliUpdateLastResultSchema.safeParse(JSON.parse(readFileSync(resolveLastUpdatePath(layout), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function recordLastUpdate(layout: FirstPartyInstallLayout, result: Readonly<{
  targetVersion: string;
  outcome: CliUpdateOutcome;
  message: string | null;
}>): Promise<void> {
  const path = resolveLastUpdatePath(layout);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const record: CliUpdateLastResult = { ...result, at: Date.now() };
  await mkdir(layout.installRoot, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(record)}\n`, 'utf8');
  await rename(tempPath, path).catch(async (error: unknown) => {
    await rm(tempPath, { force: true });
    throw error;
  });
}

function resolveStagedBinaryPath(payloadRoot: string): string {
  const { binaryRelativePath } = getFirstPartyComponentCatalogEntry(COMPONENT_ID);
  return joinPathForPathShape(payloadRoot, process.platform === 'win32' ? `${binaryRelativePath}.exe` : binaryRelativePath);
}

/**
 * The one first-party CLI update transaction (plan R13 f), used by `happier self update`, the
 * desktop's `cli.update.v1` and the daemon-hosted remote `cli.update.v1` (which runs
 * `self update` detached from the daemon). It always runs from the version being replaced.
 *
 * 1. Resolve the target version once and acquire it (download + minisign verification). Every later
 *    step is bound to that version.
 * 2. Smoke the staged executable: its `--version` must be the target, or nothing is activated.
 * 3. Under the install mutation lock, capture all activation state, then activate without pruning.
 * 4. When the service's own daemon was running, restart it onto the new version and prove it.
 * 5. Commit and prune — or, when activation or that proof failed locally, restore everything and
 *    restart the previous binary. Relay reachability is never part of the proof: a machine that is
 *    offline after a good local restart has updated.
 * 6. Record the outcome in `last-update.json` (`pendingReconnect` while the service restarts), which
 *    the daemon publishes with its update facts on its next start.
 */
export async function runManagedCliUpdate(params: ManagedCliUpdateParams): Promise<ManagedCliUpdateResult> {
  const layout = resolveFirstPartyInstallLayout({ componentId: COMPONENT_ID, channel: params.channel, processEnv: params.processEnv });
  const preparePayload = params.preparePayload ?? prepareFirstPartyComponentPayloadFromGitHubRelease;

  params.signal?.throwIfAborted();
  const prepared = await preparePayload({
    componentId: COMPONENT_ID,
    channel: params.channel,
    ...(params.targetVersion ? { versionId: params.targetVersion } : {}),
    signal: params.signal,
    onProgress: params.onProgress,
  });
  const targetVersion = prepared.versionId;

  try {
    params.onProgress?.({ phase: 'checkingCli' });
    const reported = (await params.readVersion(resolveStagedBinaryPath(prepared.payloadRoot)))?.trim() ?? null;
    if (reported !== targetVersion) {
      const message = `The downloaded Happier CLI ${targetVersion} did not start on this machine`
        + ` (it reported ${reported ? `version ${reported}` : 'no version'}); nothing was changed.`;
      await recordLastUpdate(layout, { targetVersion, outcome: 'failed', message });
      throw new ManagedCliUpdateError('cli_update_smoke_failed', message, targetVersion);
    }
    params.signal?.throwIfAborted();

    return await withFirstPartyPayloadMutationLock({
      layout,
      operation: async () => await activateAndProve({ params, layout, prepared, targetVersion }),
    });
  } finally {
    await prepared.cleanup().catch(() => undefined);
  }
}

async function activateAndProve(input: Readonly<{
  params: ManagedCliUpdateParams;
  layout: FirstPartyInstallLayout;
  prepared: Pick<PreparedFirstPartyComponentPayload, 'payloadRoot'>;
  targetVersion: string;
}>): Promise<ManagedCliUpdateResult> {
  const { params, layout, targetVersion } = input;
  const restart = params.restartServiceDaemon;
  const { currentVersionId } = await readInstalledVersionMarkers(layout);

  if (currentVersionId === targetVersion) {
    // Nothing to activate. A service daemon still on an older build is moved onto it.
    if (restart) {
      try {
        await restart({ expectedVersion: targetVersion, phase: 'activated' });
      } catch (error) {
        const message = `Happier CLI ${targetVersion} is installed, but the background service did not restart onto it: ${describeError(error)}`;
        await recordLastUpdate(layout, { targetVersion, outcome: 'failed', message });
        return { outcome: 'failed', previousVersion: currentVersionId, targetVersion, message };
      }
    }
    await recordLastUpdate(layout, { targetVersion, outcome: 'succeeded', message: null });
    return { outcome: 'succeeded', previousVersion: currentVersionId, targetVersion, restarted: restart !== null, changed: false };
  }

  const snapshot = await captureInstalledPayloadStateForActivation({
    componentId: COMPONENT_ID,
    channel: params.channel,
    processEnv: params.processEnv,
  });
  const previousVersion = snapshot.currentVersionId;

  const rollBack = async (failure: unknown): Promise<ManagedCliUpdateResult> => {
    const reason = describeError(failure);
    if (!previousVersion) {
      const message = `Happier CLI ${targetVersion} did not start on this machine (${reason}), and no previous version was installed to restore.`;
      await recordLastUpdate(layout, { targetVersion, outcome: 'failed', message });
      return { outcome: 'failed', previousVersion, targetVersion, message };
    }
    try {
      await restoreInstalledPayloadState(snapshot);
      const message = `Happier CLI ${targetVersion} did not start on this machine (${reason}); ${previousVersion} was restored.`;
      await recordLastUpdate(layout, { targetVersion, outcome: 'rolledBack', message });
      await restart?.({ expectedVersion: previousVersion, phase: 'restored' });
      return { outcome: 'rolledBack', previousVersion, targetVersion, message };
    } catch (restoreError) {
      const message = `Happier CLI ${targetVersion} did not start on this machine (${reason}), and restoring ${previousVersion} failed: ${describeError(restoreError)}`;
      await recordLastUpdate(layout, { targetVersion, outcome: 'failed', message });
      return { outcome: 'failed', previousVersion, targetVersion, message };
    }
  };

  try {
    await params.beforeActivate?.();
    await activateVersionedPayload({
      componentId: COMPONENT_ID,
      versionId: targetVersion,
      payloadRoot: input.prepared.payloadRoot,
      payloadRootAlreadyFiltered: true,
      channel: params.channel,
      processEnv: params.processEnv,
      onProgress: params.onProgress,
    });
  } catch (error) {
    return await rollBack(error);
  }

  if (restart) {
    await recordLastUpdate(layout, { targetVersion, outcome: 'pendingReconnect', message: null });
    try {
      await restart({ expectedVersion: targetVersion, phase: 'activated' });
    } catch (error) {
      return await rollBack(error);
    }
  }

  await discardInstalledPayloadStateSnapshot(snapshot);
  await pruneInstalledVersionsAfterActivation({
    componentId: COMPONENT_ID,
    channel: params.channel,
    processEnv: params.processEnv,
    currentVersionId: targetVersion,
    previousVersionId: previousVersion,
  });
  await recordLastUpdate(layout, { targetVersion, outcome: 'succeeded', message: null });
  return { outcome: 'succeeded', previousVersion, targetVersion, restarted: restart !== null, changed: true };
}
