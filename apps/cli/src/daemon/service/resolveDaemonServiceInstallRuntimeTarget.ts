import { realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  readDefaultManagedReleaseChannel,
  readHappierCliChoiceSync,
  resolveDesiredShimTargets,
  resolveInstalledFirstPartyComponentPaths,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { PUBLIC_RELEASE_RING_IDS, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { buildMissingJavaScriptRuntimeMessage } from '@/runtime/js/buildMissingJavaScriptRuntimeMessage';
import { ensureJavaScriptRuntimeExecutable } from '@/runtime/js/ensureJavaScriptRuntimeExecutable';

import type { DaemonServiceTargetMode } from './plan';
import { resolveDaemonServiceRuntimeTarget } from './runtimeTarget';

async function resolveManagedReleaseChannelShimPath(params: Readonly<{
  channel: PublicReleaseRingId;
  processEnv: NodeJS.ProcessEnv;
}>): Promise<string | null> {
  const defaultShimPath = (await resolveDesiredShimTargets({
    componentId: 'happier-daemon',
    channel: params.channel,
    processEnv: params.processEnv,
  }))[0]?.shimPath ?? resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-daemon',
    channel: params.channel,
    processEnv: params.processEnv,
  }).shimPaths[0];
  if (!defaultShimPath) {
    return null;
  }

  try {
    await access(defaultShimPath);
    return defaultShimPath;
  } catch {
    return null;
  }
}

async function resolveDefaultFollowingManagedShimPath(processEnv: NodeJS.ProcessEnv): Promise<string | null> {
  const defaultReleaseChannel = await readDefaultManagedReleaseChannel({ processEnv });
  return await resolveManagedReleaseChannelShimPath({
    channel: defaultReleaseChannel,
    processEnv,
  });
}

/**
 * The managed shim a service of this target runs when nothing overrides it: the default channel's
 * `happier` shim for the default-following service, the channel shim for a pinned one. `null`
 * when that shim is not installed, or when this computer chose to keep its own CLI (plan R12): the
 * service then runs the CLI that installs it, so a copy the managed layout still holds is never
 * the expected runtime and no switch to it is proposed.
 */
export async function resolveManagedDaemonServiceShimPath(params: Readonly<{
  targetMode: DaemonServiceTargetMode;
  channel?: PublicReleaseRingId | null;
  processEnv: NodeJS.ProcessEnv;
}>): Promise<string | null> {
  if (readHappierCliChoiceSync({ processEnv: params.processEnv })?.mode === 'own') {
    return null;
  }
  if (params.targetMode === 'default-following') {
    return await resolveDefaultFollowingManagedShimPath(params.processEnv);
  }
  return params.channel
    ? await resolveManagedReleaseChannelShimPath({ channel: params.channel, processEnv: params.processEnv })
    : null;
}

/**
 * Whether a service definition's launcher runs the CLI the managed install layout owns in this
 * Happier home — a managed shim, or a payload under a channel's install root (the shims are links
 * into it, so a resolved `versions/<id>` path counts too) — rather than a CLI the user installed
 * themselves (npm, Homebrew, a checkout). Paths that no longer exist are compared as written.
 */
export function isManagedCliDaemonServiceLauncher(
  launcher: readonly string[],
  processEnv: NodeJS.ProcessEnv,
): boolean {
  const installs = PUBLIC_RELEASE_RING_IDS.map((channel) => resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-cli',
    channel,
    processEnv,
  }));
  const shimPaths = new Set(installs.flatMap((install) => install.shimPaths.map((shimPath) => resolve(shimPath))));
  const installRoots = installs.flatMap((install) => [resolve(install.installRoot), realpathOrSelf(install.installRoot)]);
  return launcher.filter((element) => isAbsolute(element)).some((element) => {
    const candidates = [resolve(element), realpathOrSelf(element)];
    return candidates.some((candidate) => shimPaths.has(candidate)
      || installRoots.some((root) => isInsidePath(root, candidate)));
  });
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInsidePath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export async function resolveDaemonServiceInstallRuntimeTarget(options: Readonly<{
  currentExecPath?: string | null;
  explicitNodePath?: string | null;
  explicitEntryPath?: string | null;
  allowBootstrap?: boolean;
  targetMode?: DaemonServiceTargetMode;
  channel?: PublicReleaseRingId | null;
  processEnv?: NodeJS.ProcessEnv;
}> = {}): Promise<Readonly<{
  nodePath: string;
  entryPath: string;
}>> {
  const currentExecPath = options.currentExecPath ?? process.execPath;
  const explicitNodePath = String(options.explicitNodePath ?? '').trim();
  const explicitEntryPath = String(options.explicitEntryPath ?? '').trim();
  const allowBootstrap = options.allowBootstrap ?? true;
  const targetMode: DaemonServiceTargetMode = options.targetMode ?? 'pinned';
  const processEnv = options.processEnv ?? process.env;

  if (!explicitNodePath && !explicitEntryPath) {
    const managedShimPath = await resolveManagedDaemonServiceShimPath({
      targetMode,
      channel: options.channel,
      processEnv,
    });
    if (managedShimPath) {
      return resolveDaemonServiceRuntimeTarget({
        currentExecPath,
        explicitNodePath: managedShimPath,
      });
    }
  }

  if (!allowBootstrap && !explicitNodePath && !explicitEntryPath) {
    throw new ReferenceError('Daemon service runtime bootstrap is disabled for this resolution');
  }

  const runtimeExecutable = explicitNodePath
    ? null
    : await ensureJavaScriptRuntimeExecutable({
        isBunRuntime: false,
        currentExecPath,
        processEnv,
    });

  if (!explicitNodePath && !runtimeExecutable && !explicitEntryPath) {
    throw new ReferenceError(buildMissingJavaScriptRuntimeMessage('Daemon service installation'));
  }

  return resolveDaemonServiceRuntimeTarget({
    currentExecPath,
    runtimeExecutable,
    explicitNodePath,
    explicitEntryPath,
  });
}
