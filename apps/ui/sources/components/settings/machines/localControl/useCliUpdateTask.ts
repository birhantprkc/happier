import * as React from 'react';

import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { desktopSetupCoordinator } from '@/setup/desktopSetupCoordinator';
import { cliAcquisitionFailureStatus } from '@/setup/setupStageModel';
import { t } from '@/text';

import { buildLocalDaemonServiceSystemTaskSpec } from './buildLocalDaemonServiceSystemTaskSpec';

export type CliUpdateTask = Readonly<{
    /** Starts `cli.update.v1`. A second press while one runs does nothing. */
    start: () => Promise<void>;
    /** The run, for the existing task progress presentation. */
    snapshot: SystemTaskRunState | null;
    running: boolean;
    /** Why the update could not start or did not finish, in words the row can show. */
    errorMessage: string | null;
}>;

type CliUpdateActionState = Readonly<{
    taskId: string | null;
    starting: boolean;
    startError: string | null;
}>;

type CliUpdateAction = Readonly<{
    getState: () => CliUpdateActionState;
    subscribe: (listener: () => void) => () => void;
    start: () => Promise<void>;
}>;

/**
 * S-10 — ONE action per runner, shared by every surface that offers "Update" for this computer's
 * command line (the Home setup panel, Settings › This computer, Settings › Updates). A module-level
 * owner rather than per-mount state: two surfaces used to hold two task ids and two `running`
 * guards, so each could start its own `cli.update.v1`. The run itself stays the system task's
 * (`useSystemTaskSnapshot`); this owns only which run is current and its start error. Mutation
 * exclusion across processes is the install owner's (lane D).
 */
const actionsByRunner = new WeakMap<SystemTaskRunner, CliUpdateAction>();

function isRunInFlight(runner: SystemTaskRunner, state: CliUpdateActionState): boolean {
    if (state.starting) return true;
    if (!state.taskId) return false;
    const snapshot = runner.getSnapshot(state.taskId);
    return snapshot != null && snapshot.result == null;
}

function createCliUpdateAction(runner: SystemTaskRunner): CliUpdateAction {
    let state: CliUpdateActionState = { taskId: null, starting: false, startError: null };
    const listeners = new Set<() => void>();
    const set = (next: CliUpdateActionState) => {
        state = next;
        for (const listener of listeners) listener();
    };

    return {
        getState: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        start: async () => {
            if (isRunInFlight(runner, state) || runner.mode === 'unavailable') {
                return;
            }
            set({ ...state, starting: true, startError: null });
            try {
                const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec('cli.update.v1'));
                set({ taskId, starting: false, startError: null });
                // Success is re-read, never inferred from the exit code: every surface describing
                // this computer sees the version the service now runs.
                const unsubscribe = runner.subscribe(taskId, undefined, (result) => {
                    queueMicrotask(() => unsubscribe());
                    // A finished update, or another one already running on this computer (K5
                    // `cli_update_in_progress`): either way the answer is what the CLI now reports.
                    if (result.ok || isUpdateInProgressElsewhere(result.error)) {
                        void desktopSetupCoordinator.inspect({ fresh: true });
                    }
                });
            } catch (error) {
                set({
                    ...state,
                    starting: false,
                    startError: isSystemTaskBridgeUnavailableError(error)
                        ? t('settings.systemTaskBridgeUnavailable')
                        : (readSystemTaskStartErrorMessage(error) ?? t('settings.systemTaskStartFailed')),
                });
            }
        },
    };
}

function resolveCliUpdateAction(runner: SystemTaskRunner): CliUpdateAction {
    const existing = actionsByRunner.get(runner);
    if (existing) return existing;
    const created = createCliUpdateAction(runner);
    actionsByRunner.set(runner, created);
    return created;
}

/**
 * R17 — the one "Update" action for this computer's command line. The executor owns the update
 * (K2: acquisition owner, then a service restart); every caller observes the same shared run
 * (S-10), and `onSucceeded` fires once per caller for each run that finished while it watched.
 */
export function useCliUpdateTask(options: Readonly<{
    runner?: SystemTaskRunner;
    /** After the re-inspection has started — e.g. the setup gate retrying the run the update unblocked. */
    onSucceeded?: () => void;
}> = {}): CliUpdateTask {
    const runner = options.runner ?? getSystemTasksRunner();
    const action = resolveCliUpdateAction(runner);
    const state = React.useSyncExternalStore(action.subscribe, action.getState, action.getState);
    const snapshot = useSystemTaskSnapshot(runner, state.taskId);
    const failure = snapshot?.result && !snapshot.result.ok ? snapshot.result.error : null;
    // Another update already running is in progress, not an error: it reads as running while
    // this computer is re-read, and the re-read facts say where it ended.
    const inProgressElsewhere = isUpdateInProgressElsewhere(failure);
    const refreshing = React.useSyncExternalStore(
        desktopSetupCoordinator.subscribe,
        () => desktopSetupCoordinator.readInspectionRefreshing(),
        () => desktopSetupCoordinator.readInspectionRefreshing(),
    );
    const running = state.starting
        || (snapshot != null && snapshot.result == null)
        || (inProgressElsewhere && refreshing);

    const onSucceededRef = React.useRef(options.onSucceeded);
    onSucceededRef.current = options.onSucceeded;
    // A run that had already finished before this caller mounted is not "just succeeded" for it.
    const handledTaskIdRef = React.useRef<string | null>(snapshot?.result ? snapshot.taskId : null);
    React.useEffect(() => {
        if (!snapshot?.result?.ok || handledTaskIdRef.current === snapshot.taskId) {
            return;
        }
        handledTaskIdRef.current = snapshot.taskId;
        onSucceededRef.current?.();
    }, [snapshot]);

    return {
        start: action.start,
        snapshot,
        running,
        errorMessage: state.startError ?? (failure && !inProgressElsewhere ? describeCliUpdateFailure(failure) : null),
    };
}

/**
 * Why `cli.update.v1` did not finish, in the one sentence a row or the setup surface shows: the
 * CLI is not the app's to replace, the download/install step that stopped (the same sentences the
 * setup acquisition uses), or the new version installed while the service kept the old one.
 */
export function describeCliUpdateFailure(failure: Readonly<{ code: string }>): string {
    if (failure.code === 'cli_not_managed') return t('machine.thisComputer.cliNotManaged');
    // K5 (lane D): the transaction restored the previous version, or the new one never ran.
    if (failure.code === 'cli_update_rolled_back') return t('updates.row.rolledBackLocal');
    if (failure.code === 'cli_update_smoke_failed') return t('updates.row.smokeFailed');
    return cliAcquisitionFailureStatus(failure.code) ?? t('machine.thisComputer.cliUpdateFailed');
}

function isUpdateInProgressElsewhere(failure: Readonly<{ code: string }> | null | undefined): boolean {
    return failure?.code === 'cli_update_in_progress';
}
