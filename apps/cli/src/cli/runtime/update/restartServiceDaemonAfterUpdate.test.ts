import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { DaemonOwnerEvaluation } from '@/daemon/ownership/evaluateCurrentDaemonOwner';

vi.mock('@/daemon/doctor', async (importOriginal) => {
  const [{ withCurrentProcessAsDaemonLifecycleOwner }, actual] = await Promise.all([
    import('@/testkit/process/daemonLifecycleOwner'),
    importOriginal<typeof import('@/daemon/doctor')>(),
  ]);
  return withCurrentProcessAsDaemonLifecycleOwner(actual);
});

const SCOPED_ENV_KEYS = [
  'HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
  'HAPPIER_PUBLIC_RELEASE_CHANNEL',
] as const;

type SpawnCall = Readonly<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }>;

async function loadWithSpawnRecorder(options: Readonly<{ onRestart?: () => void; status?: number }> = {}): Promise<Readonly<{
  calls: SpawnCall[];
  restart: (params: Readonly<{ channel: 'stable' | 'preview'; updatedToVersion: string; ownerBeforeUpdate?: DaemonOwnerEvaluation }>) => Promise<unknown>;
  writeDaemonState: typeof import('@/persistence').writeDaemonState;
  serviceLabel: string;
}>> {
  const calls: SpawnCall[] = [];
  vi.resetModules();
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
      ...actual,
      spawnSync: vi.fn((command: string, args: readonly string[] = [], spawnOptions?: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ command, args, env: spawnOptions?.env });
        if (args.join(' ') === 'daemon service restart') options.onRestart?.();
        return { status: options.status ?? 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
      }),
    };
  });
  const [
    { planServiceDaemonRestartAfterUpdate, restartServiceDaemonOntoInstalledCli },
    { writeDaemonState },
    { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths },
    { evaluateCurrentDaemonOwner },
  ] = await Promise.all([
    import('./restartServiceDaemonAfterUpdate'),
    import('@/persistence'),
    import('@/daemon/service/cli'),
    import('@/daemon/ownership/evaluateCurrentDaemonOwner'),
  ]);
  const serviceLabel = resolveDaemonServicePaths(resolveDaemonServiceCliRuntimeFromEnv({
    channel: 'stable',
    targetMode: 'default-following',
  })).label;
  // The update's two halves, as `self update` composes them: plan from the owner observed before
  // the update, then restart onto the installed CLI and prove the version.
  const restart = async (params: Readonly<{ channel: 'stable' | 'preview'; updatedToVersion: string; ownerBeforeUpdate?: DaemonOwnerEvaluation }>) => {
    const plan = planServiceDaemonRestartAfterUpdate({
      channel: params.channel,
      ownerBeforeUpdate: params.ownerBeforeUpdate ?? await evaluateCurrentDaemonOwner(),
    });
    if (plan.kind !== 'restart') return plan;
    await restartServiceDaemonOntoInstalledCli({ plan, expectedVersion: params.updatedToVersion });
    return { kind: 'restarted' };
  };
  return { calls, restart, writeDaemonState, serviceLabel };
}

describe('service daemon restart after an update', { timeout: 120_000 }, () => {
  let envScope = createEnvKeyScope(SCOPED_ENV_KEYS);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(SCOPED_ENV_KEYS);
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  function patchHome(homeDir: string): void {
    const happierHomeDir = `${homeDir}/.happier`;
    envScope.patch({
      HAPPIER_HOME_DIR: happierHomeDir,
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: undefined,
      HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
    });
  }

  it('restarts the channel service daemon through the updated binary so it runs the new version', async () => {
    await withTempDir('happier-self-update-restart-service-', async (homeDir) => {
      patchHome(homeDir);
      const writeState = (version: string, label: string) => ({
        pid: process.pid,
        httpPort: 43150,
        startedAt: Date.now(),
        startedWithCliVersion: version,
        startedWithPublicReleaseChannel: 'stable' as const,
        startupSource: 'background-service' as const,
        serviceLabel: label,
      });
      let restartedLabel = '';
      const { calls, restart, writeDaemonState, serviceLabel } = await loadWithSpawnRecorder({
        onRestart: () => writeDaemonState(writeState('1.1.0', restartedLabel)),
      });
      restartedLabel = serviceLabel;
      writeDaemonState(writeState('1.0.0', serviceLabel));

      const result = await restart({ channel: 'stable', updatedToVersion: '1.1.0' });

      expect(result).toEqual({ kind: 'restarted' });
      const restartCall = calls.find((call) => call.args.join(' ') === 'daemon service restart');
      expect(restartCall?.command).toMatch(/[\\/]cli[\\/]current[\\/]happier(?:\.exe)?$/);
      expect(restartCall?.env?.HAPPIER_DAEMON_SERVICE_TARGET_MODE).toBe('default-following');
    });
  });

  it('restarts the service daemon observed before an update that stopped it (Windows quiesce)', async () => {
    await withTempDir('happier-self-update-restart-quiesced-', async (homeDir) => {
      patchHome(homeDir);
      const { calls, restart, serviceLabel, writeDaemonState } = await loadWithSpawnRecorder({
        onRestart: () => writeDaemonState({
          pid: process.pid,
          httpPort: 43153,
          startedAt: Date.now(),
          startedWithCliVersion: '1.1.0',
          startedWithPublicReleaseChannel: 'stable',
          startupSource: 'background-service',
          serviceLabel,
        }),
      });
      const ownerBeforeUpdate = {
        kind: 'compatible' as const,
        owner: {
          status: 'running' as const,
          source: 'state' as const,
          state: {
            pid: 999999,
            httpPort: 43153,
            startedAt: Date.now(),
            startedWithCliVersion: '1.0.0',
            startedWithPublicReleaseChannel: 'stable' as const,
            startupSource: 'background-service' as const,
            serviceLabel,
          },
          currentCliVersion: '1.0.0',
          currentPublicReleaseChannel: 'stable' as const,
          versionMatches: true,
          releaseChannelMatches: true,
          serviceManaged: true,
          startupSource: 'background-service' as const,
        },
      };

      expect(await restart({ channel: 'stable', updatedToVersion: '1.1.0', ownerBeforeUpdate })).toEqual({ kind: 'restarted' });
      expect(calls.some((call) => call.args.join(' ') === 'daemon service restart')).toBe(true);
    });
  });

  it('leaves a manual daemon and another channel\'s service daemon running', async () => {
    await withTempDir('happier-self-update-restart-skip-', async (homeDir) => {
      patchHome(homeDir);
      const { calls, restart, writeDaemonState, serviceLabel } = await loadWithSpawnRecorder();
      writeDaemonState({
        pid: process.pid,
        httpPort: 43151,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'manual',
      });
      expect(await restart({ channel: 'stable', updatedToVersion: '1.1.0' })).toEqual({ kind: 'skip', reason: 'not-service-managed' });

      writeDaemonState({
        pid: process.pid,
        httpPort: 43152,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'background-service',
        serviceLabel,
      });
      expect(await restart({ channel: 'preview', updatedToVersion: '1.1.0-preview.1' })).toEqual({ kind: 'skip', reason: 'other-channel' });
      expect(calls.some((call) => call.args.join(' ') === 'daemon service restart')).toBe(false);
    });
  });
  it('fails when the restarted service does not run the expected version, so the update can roll back', async () => {
    await withTempDir('happier-self-update-restart-unproven-', async (homeDir) => {
      patchHome(homeDir);
      const { restart, writeDaemonState, serviceLabel } = await loadWithSpawnRecorder();
      writeDaemonState({
        pid: process.pid,
        httpPort: 43154,
        startedAt: Date.now(),
        startedWithCliVersion: '1.0.0',
        startedWithPublicReleaseChannel: 'stable',
        startupSource: 'background-service',
        serviceLabel,
      });
      // `daemon service restart` exited 0, but the owner still runs the old version.
      await expect(restart({ channel: 'stable', updatedToVersion: '1.1.0' })).rejects.toThrow(/runs 1\.0\.0 instead of 1\.1\.0/);
    });
  });
});
