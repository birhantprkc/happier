import * as React from 'react';

import { useCliUpdateTask } from '@/components/settings/machines/localControl/useCliUpdateTask';
import { desktopSetupCoordinator } from '@/setup/desktopSetupCoordinator';
import { t } from '@/text';
import { isTauriDesktop } from '@/utils/platform/tauri';

import { buildThisComputerCliUpdateItem } from './items/buildMachineUpdateItems';
import type { UpdateItem } from './items/updateItem';
import { recordUpdateCompleted } from './machineUpdateRuns';

export type ThisComputerCliUpdate = Readonly<{
    /** `null` off the desktop app, and until this computer's inspection has answered. */
    item: UpdateItem | null;
    machineId: string | null;
    run: () => Promise<void>;
}>;

const NOOP = async () => {};

/**
 * This computer's Happier CLI row, from the one ambient inspection (never a read of its own) and
 * the one shared CLI-update action (S-10). Cheap: it subscribes to state other surfaces already
 * hold, so the always-mounted summary may use it.
 */
export function useThisComputerCliUpdate(): ThisComputerCliUpdate {
    const desktop = React.useMemo(() => isTauriDesktop(), []);
    const inspection = React.useSyncExternalStore(
        desktopSetupCoordinator.subscribe,
        desktopSetupCoordinator.readInspectionSnapshot,
        desktopSetupCoordinator.readInspectionSnapshot,
    );
    const itemIdRef = React.useRef<string | null>(null);
    const onSucceeded = React.useCallback(() => {
        if (itemIdRef.current) recordUpdateCompleted(itemIdRef.current);
    }, []);
    const task = useCliUpdateTask({ onSucceeded });
    const facts = desktop && inspection.status === 'resolved' ? inspection.facts : null;
    const machineId = facts?.auth.machineId ?? null;
    const cliUpdate = facts?.cliUpdate ?? null;
    const provenance = facts?.acquisition.provenance ?? null;
    const currentVersion = facts?.acquisition.version ?? cliUpdate?.currentVersion ?? null;

    const item = React.useMemo(() => {
        if (!facts) return null;
        return buildThisComputerCliUpdateItem({
            machineId: machineId ?? 'this-computer',
            title: t('updates.happierCliTitle'),
            facts: {
                currentVersion,
                latestVersion: cliUpdate?.latestVersion ?? null,
                managed: provenance === 'managed' && cliUpdate?.managed !== false,
                updateCommand: null,
            },
            task: { running: task.running, step: task.running ? 'installing' : null, errorMessage: task.errorMessage },
        });
    }, [cliUpdate?.latestVersion, cliUpdate?.managed, currentVersion, facts, machineId, provenance, task.errorMessage, task.running]);

    itemIdRef.current = item?.id ?? null;
    return React.useMemo(() => ({ item, machineId, run: desktop ? task.start : NOOP }), [desktop, item, machineId, task.start]);
}
