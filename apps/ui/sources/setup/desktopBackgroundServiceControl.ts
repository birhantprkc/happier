import type { SystemTaskSpec } from '@happier-dev/protocol';

import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/settings/machines/localControl/buildLocalDaemonServiceSystemTaskSpec';
import type { DesktopBackgroundServiceAutostartMode } from '@/setup/deriveDesktopLocalSetupSnapshot';
import { awaitSystemTaskResult } from '@/components/systemTasks/awaitSystemTaskResult';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import type { SystemTaskRunner } from '@/components/systemTasks/types';

/**
 * The background-service commands the desktop app issues on its own behalf: the installed
 * service's autostart mode, starting it as the app opens, and stopping it as the app quits.
 *
 * Both are the CLI's commands — bootstrap sequences them and re-reads the result, and nothing
 * here restates a service rule (INV9). This module exists so the settings toggle and the app-close
 * guard issue them through one place instead of each wiring the runner.
 */
async function runLocalServiceTask(spec: SystemTaskSpec, runner: SystemTaskRunner): Promise<void> {
    const taskId = await runner.start(spec);
    const result = await awaitSystemTaskResult(runner, taskId);
    if (!result.ok) {
        throw new Error(result.error.message || result.error.code);
    }
}

export async function setBackgroundServiceAutostart(
    autostart: DesktopBackgroundServiceAutostartMode,
    runner: SystemTaskRunner = getSystemTasksRunner(),
): Promise<void> {
    await runLocalServiceTask(
        buildLocalDaemonServiceSystemTaskSpec('daemon.service.autostart.set.v1', { autostart }),
        runner,
    );
}

/**
 * Starts the installed service, which is how "it answers while the app is open" is kept for an
 * on-demand service the app-close guard stopped (H6). It is the same CLI command the settings row
 * uses; the gate runs it as a check rather than as setup, because nothing about this computer
 * needs configuring — the service is already installed for this relay and account.
 */
export async function startBackgroundService(
    runner: SystemTaskRunner = getSystemTasksRunner(),
): Promise<void> {
    await runLocalServiceTask(buildLocalDaemonServiceSystemTaskSpec('daemon.service.start.v1'), runner);
}

export async function stopBackgroundService(
    runner: SystemTaskRunner = getSystemTasksRunner(),
): Promise<void> {
    await runLocalServiceTask(buildLocalDaemonServiceSystemTaskSpec('daemon.service.stop.v1'), runner);
}
