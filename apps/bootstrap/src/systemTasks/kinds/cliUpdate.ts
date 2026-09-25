import { systemTasks } from '@happier-dev/cli-common';

import { reportCliAcquisitionProgress } from '../cliAcquisitionProgress.js';
import { updateManagedLocalHappierCli } from '../happierCli.js';
import { controlDaemonService, createSelectedCliInvocation, readDaemonStatus } from '../localDaemonCli.js';
import { parseBootstrapChannelParam } from './daemonService.js';

export type CliUpdateTaskResult = Readonly<{
  previousVersion: string;
  version: string;
  /** Whether the service daemon was running and was restarted onto (and proved to run) the new version. */
  restarted: boolean;
}>;

function parseCliUpdateParams(params: unknown) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new systemTasks.SystemTaskExecutionError('invalid_params', 'CLI update params must be an object.');
  }
  return { releaseRing: parseBootstrapChannelParam((params as Record<string, unknown>).channel) };
}

/**
 * `cli.update.v1` — the desktop's one "Update" action (plan R17/K2, R13 f). Runs the one CLI update
 * transaction on this computer's managed CLI (same progress events as a first acquisition). When
 * this computer's background service is running its daemon, the transaction restarts it through
 * the CLI service owner and proves it runs the new version; if that is not proven, every piece of
 * activation state is restored and the previous version restarted, and the task fails
 * `cli_update_rolled_back`. A daemon that was not running is not started, and a manual daemon is
 * not the service's to restart.
 *
 * Status reads and the restart run with the inherited relay selectors cleared (R13 a): they answer
 * for the relay this home's persisted selection names, which is what the background service
 * serves, so the daemon verified is the daemon restarted even under a stack-pinned launch.
 */
export function createCliUpdateHandler() {
  return async function* (
    params: unknown,
    context: Readonly<{ signal: AbortSignal; emit?: (event: unknown) => void }>,
  ): AsyncGenerator<never, CliUpdateTaskResult, void> {
    const { releaseRing } = parseCliUpdateParams(params);
    const onProgress = context.emit ? reportCliAcquisitionProgress(context.emit) : undefined;
    const { previousVersion, cli, restarted } = await updateManagedLocalHappierCli({
      releaseRing,
      signal: context.signal,
      onProgress,
      planRestart: async (current) => {
        const service = createSelectedCliInvocation({ cli: current, processEnv: process.env });
        const status = await readDaemonStatus(releaseRing, service);
        const serviceDaemonRunning = status.service.installed && status.daemon.running && status.daemon.serviceManaged === true;
        if (!serviceDaemonRunning) {
          return null;
        }
        return async ({ expectedVersion }) => {
          await controlDaemonService(releaseRing, { action: 'restart', takeover: false }, service);
          const restartedStatus = await readDaemonStatus(releaseRing, service);
          const runningVersion = restartedStatus.daemon.startedWithCliVersion;
          if (!restartedStatus.daemon.running || runningVersion !== expectedVersion) {
            throw new Error(`the background service runs ${runningVersion ?? 'no daemon'} instead of ${expectedVersion}`);
          }
        };
      },
    });
    context.signal.throwIfAborted();
    return { previousVersion, version: cli.version, restarted };
  };
}
