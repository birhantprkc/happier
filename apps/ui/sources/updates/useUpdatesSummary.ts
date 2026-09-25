import * as React from 'react';

import { useAllMachines } from '@/sync/domains/state/storage';

import { buildUpdatesSummary, type UpdatesSummary } from './items/buildUpdatesSummary';
import { useMachinesCapabilitySnapshots } from './machineCapabilitySnapshots';
import { useMachineUpdateRuns, useUnseenUpdateCompletions } from './machineUpdateRuns';
import { buildMachineUpdateGroups, readUpdatableInstallables } from './buildMachineUpdateGroups';
import { useAppUpdateStatus } from './useAppUpdateStatus';
import { useThisComputerCliUpdate } from './useThisComputerCliUpdate';

/**
 * The stable summary every always-mounted entry reads (sidebar pill, collapsed rail, phone header,
 * Settings row, tray). It classifies through the same builders the Updates surface lists, from
 * facts already on this device — no RPC: this app, this computer's Happier CLI, every machine's
 * Happier CLI from its metadata (K5), and the agent CLIs and helpers whose latest versions the
 * installables background owner keeps in the capability cache (K6).
 */
export function useUpdatesSummary(): UpdatesSummary {
    const app = useAppUpdateStatus();
    const thisComputer = useThisComputerCliUpdate();
    const machines = useAllMachines();
    const runs = useMachineUpdateRuns();
    const completions = useUnseenUpdateCompletions();
    // Observes (never fetches) the cached detects: K6 agent facts and helper latest versions that
    // the installables background owner keeps fresh, and each daemon's `tool.systemTasks` kinds.
    const machineIds = React.useMemo(() => machines.map((machine) => machine.id), [machines]);
    const snapshots = useMachinesCapabilitySnapshots(machineIds);
    const installables = React.useMemo(readUpdatableInstallables, []);
    const summary = React.useMemo(() => {
        const { groups } = buildMachineUpdateGroups({
            machines,
            thisMachineId: thisComputer.machineId,
            thisComputerItem: thisComputer.item,
            runs,
            snapshots,
            installables,
        });
        return buildUpdatesSummary([app.model.item, ...groups.flatMap((group) => group.items)], completions);
    }, [app.model.item, completions, installables, machines, runs, snapshots, thisComputer.item, thisComputer.machineId]);
    return React.useMemo(
        () => summary,
        // eslint-disable-next-line react-hooks/exhaustive-deps -- identity follows the summary's values
        [summary.actionableCount, summary.phase, summary.status, summary.visible],
    );
}
