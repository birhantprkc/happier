import * as React from 'react';
import { View } from 'react-native';

import { SystemTaskProgressCard } from '@/components/systemTasks';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useRelayDriftSummary } from '@/components/settings/server/useRelayDriftSummary';
import type { RelayDriftSummary } from '@/components/settings/server/relayDriftTypes';
import type { DesktopLocalReadinessFacts } from '@/setup/deriveDesktopLocalSetupSnapshot';
import { formatCliChannelLabel, resolveDaemonAccountLabel } from '@/setup/thisComputerLabels';
import { toRelayHostDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { t } from '@/text';

import { useCliUpdateTask } from './useCliUpdateTask';
import { useLocalDaemonControl } from './useLocalDaemonControl';

/**
 * This computer, in one sentence. When the daemon contradicts the app the drift summary says so —
 * the same words the Machines card, the sessions empty state, the sidebar and the tray use (U7).
 * Otherwise it names what the daemon is connected to (R17), or that nothing is set up yet.
 */
function resolveStatusSubtitle(facts: DesktopLocalReadinessFacts | null, drift: RelayDriftSummary | null): string {
    if (!facts) {
        return t('machine.daemonStatus.unknown');
    }
    if (drift) {
        return drift.description;
    }
    const relay = facts.server.serverUrl ? toRelayHostDisplay(facts.server.serverUrl) : null;
    const account = resolveDaemonAccountLabel(facts.auth);
    if (!facts.service.installed && !facts.runtimeConvergence?.controlReachable) {
        return t('machine.thisComputer.notSetUp');
    }
    if (relay && account && facts.runtimeConvergence?.controlReachable === true) {
        return t('machine.thisComputer.connectedAs', { relay, account });
    }
    return t('machine.daemonStatus.unknown');
}

/**
 * R17 — which command line answers for this computer. A CLI the app placed is named by version;
 * one it did not place is named by where it came from, and is never offered an update the app
 * would refuse to make.
 */
function resolveCliSubtitle(facts: DesktopLocalReadinessFacts): string {
    // R12 — once this computer answered who manages the command line, the row says that answer.
    if (facts.cliChoice.mode === 'own' && facts.acquisition.provenance !== 'managed') {
        return t('machine.thisComputer.cliChoiceOwn', { path: facts.acquisition.command });
    }
    if (facts.cliChoice.mode === 'managed' && facts.acquisition.provenance === 'managed') {
        return t('machine.thisComputer.cliChoiceManaged');
    }
    const version = facts.acquisition.version ?? facts.cliUpdate?.currentVersion ?? null;
    if (facts.acquisition.provenance !== 'managed' || facts.cliUpdate?.managed === false) {
        return version
            ? t('machine.thisComputer.cliFromPath', { version, path: facts.acquisition.command })
            : facts.acquisition.command;
    }
    if (!version) {
        return t('machine.thisComputer.cliManagedUnknownVersion');
    }
    // RV-9 — an app of another channel adopts the default channel's CLI (D2), so the channel is
    // what explains which release answers here.
    return facts.acquisition.channel
        ? t('machine.thisComputer.cliManagedOnChannel', { channel: formatCliChannelLabel(facts.acquisition.channel), version })
        : t('machine.thisComputer.cliManaged', { version });
}

/** The version beside the R12 answer, so "Managed by Happier" still says which release answers. */
function resolveCliDetail(facts: DesktopLocalReadinessFacts): string | undefined {
    return facts.cliChoice.mode !== null ? facts.acquisition.version ?? undefined : undefined;
}

/**
 * R12 — the copy of `happier` still installed beside the managed one after "Let Happier manage
 * it". Its removal command is shown and copyable, never run: it belongs to the package manager.
 */
function resolveOldCliCopy(facts: DesktopLocalReadinessFacts | null): Readonly<{ subtitle: string; removalCommand: string | null }> | null {
    const other = facts?.cliChoice.mode === 'managed' ? facts.cliChoice.otherCli : null;
    if (!other) return null;
    return {
        subtitle: other.removalCommand
            ? t('machine.thisComputer.cliOldCopyRemove', { path: other.command, command: other.removalCommand })
            : t('machine.thisComputer.cliOldCopyPath', { path: other.command }),
        removalCommand: other.removalCommand,
    };
}

function canUpdateCli(facts: DesktopLocalReadinessFacts | null): facts is DesktopLocalReadinessFacts & { cliUpdate: NonNullable<DesktopLocalReadinessFacts['cliUpdate']> } {
    return facts?.acquisition.provenance === 'managed'
        && facts.cliUpdate?.managed === true
        && facts.cliUpdate.updateAvailable === true;
}

export const LocalDaemonControlSection = React.memo(function LocalDaemonControlSection(props: Readonly<{
    runner?: SystemTaskRunner;
}>) {
    const {
        activeTaskSnapshot,
        activeTaskTitle,
        canRepair,
        canStart,
        cancel,
        changeCommandLine,
        lastErrorMessage,
        repairBackgroundService,
        startDaemonService,
        facts,
        isBusy,
        isUnavailable,
        refreshStatus,
    } = useLocalDaemonControl({
        ...(props.runner ? { runner: props.runner } : {}),
    });
    const drift = useRelayDriftSummary();
    const cliUpdate = useCliUpdateTask(props.runner ? { runner: props.runner } : {});
    const oldCliCopy = resolveOldCliCopy(facts);
    // There is a choice to change only when another command line exists beside the managed one.
    const canChangeCli = facts?.cliChoice.otherCli != null;

    return (
        <>
            <ItemGroup title={t('machine.daemon')}>
                <Item
                    testID="settings.localDaemonControl.status"
                    title={t('machine.status')}
                    subtitle={isUnavailable ? t('settings.systemTaskBridgeUnavailable') : resolveStatusSubtitle(facts, drift)}
                    showChevron={false}
                    mode="info"
                />
                {facts?.auth.machineId ? (
                    <Item
                        testID="settings.localDaemonControl.machineId"
                        title={t('machine.machineId')}
                        subtitle={facts.auth.machineId}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                {facts ? (
                    <Item
                        testID="settings.localDaemonControl.cli"
                        title={t('machine.thisComputer.cliTitle')}
                        subtitle={resolveCliSubtitle(facts)}
                        detail={resolveCliDetail(facts)}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
                {oldCliCopy ? (
                    <Item
                        testID="settings.localDaemonControl.oldCli"
                        title={t('machine.thisComputer.cliOldCopyTitle')}
                        subtitle={oldCliCopy.subtitle}
                        {...(oldCliCopy.removalCommand ? { copy: oldCliCopy.removalCommand } : {})}
                        showChevron={false}
                        mode={oldCliCopy.removalCommand ? 'interactive' : 'info'}
                    />
                ) : null}
                {canChangeCli ? (
                    <Item
                        testID="settings.localDaemonControl.changeCli"
                        title={t('machine.thisComputer.cliChoiceChange')}
                        onPress={() => {
                            void changeCommandLine();
                        }}
                        disabled={!canRepair || cliUpdate.running}
                    />
                ) : null}
                {canUpdateCli(facts) ? (
                    <Item
                        testID="settings.localDaemonControl.updateCli"
                        title={t('machine.thisComputer.updateCliTitle')}
                        subtitle={cliUpdate.errorMessage ?? (facts.cliUpdate.latestVersion
                            ? t('machine.thisComputer.updateCliAvailable', { version: facts.cliUpdate.latestVersion })
                            : undefined)}
                        onPress={() => {
                            void cliUpdate.start();
                        }}
                        loading={cliUpdate.running}
                        disabled={isUnavailable || isBusy || cliUpdate.running}
                    />
                ) : null}
                <Item
                    testID="settings.localDaemonControl.start"
                    title={t('sessionGettingStarted.title.startDaemon')}
                    onPress={() => {
                        void startDaemonService();
                    }}
                    disabled={!canStart}
                />
                {/* One way to connect this computer here, named for what it does (U15). */}
                <Item
                    testID="settings.localDaemonControl.repair"
                    title={drift ? drift.actionLabel : t('server.relayDrift.repairAction')}
                    onPress={() => {
                        void repairBackgroundService();
                    }}
                    disabled={!canRepair || cliUpdate.running}
                />
                <Item
                    testID="settings.localDaemonControl.refresh"
                    title={t('common.refresh')}
                    onPress={refreshStatus}
                    disabled={isBusy || isUnavailable}
                />
                {lastErrorMessage ? (
                    <Item
                        title={t('common.error')}
                        subtitle={lastErrorMessage}
                        showChevron={false}
                        mode="info"
                    />
                ) : null}
            </ItemGroup>
            {activeTaskSnapshot ? (
                <SystemTaskProgressCard
                    title={activeTaskTitle ?? t('machine.daemon')}
                    snapshot={activeTaskSnapshot}
                    onCancel={cancel}
                />
            ) : null}
            {cliUpdate.snapshot && cliUpdate.running ? (
                <SystemTaskProgressCard
                    title={t('machine.thisComputer.updatingCli')}
                    snapshot={cliUpdate.snapshot}
                />
            ) : null}
        </>
    );
});
