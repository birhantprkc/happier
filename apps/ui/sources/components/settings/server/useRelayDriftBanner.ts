import * as React from 'react';

import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import { useThisComputerSetupTask } from '@/components/systemTasks/useThisComputerSetupTask';
import { presentSetupServiceConsent } from '@/setup/presentSetupServiceConsent';
import { presentUnmanagedCliConsent } from '@/setup/presentUnmanagedCliConsent';
import { useDesktopLocalInspection } from '@/setup/useDesktopLocalInspection';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { useAuth } from '@/auth/context/AuthContext';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { RelayDriftBanner } from './relayDriftTypes';
import { useRelayDriftSummary } from './useRelayDriftSummary';

/**
 * The drift summary plus its one repair: the same explicit-target executor every other caller
 * starts (SB6), through the coordinator — which asks before an ACCOUNT move (D1).
 */
export function useRelayDriftBanner(): RelayDriftBanner | null {
    const auth = useAuth();
    const summary = useRelayDriftSummary();
    const activeServerSnapshot = getActiveServerSnapshot();
    const runner = React.useMemo(() => getDefaultSystemTaskRunner(), []);
    const desktop = isTauriDesktop();
    const { refresh: refreshLocalInspection } = useDesktopLocalInspection(desktop);
    const isRepairUnavailable = runner.mode === 'unavailable';

    // The account this repair is for, read from the same owner the executor spec is built from, so
    // the app never approves a pairing bound to a different account (INV2).
    const expectedAccountId = getActiveServerAccountScope()?.accountId ?? null;
    const setupTask = useThisComputerSetupTask({
        runner,
        ...(expectedAccountId
            ? {
                authRequestApproval: {
                    expectedRelayUrl: activeServerSnapshot.serverUrl,
                    expectedAccountId,
                    serverId: activeServerSnapshot.serverId,
                },
            }
            : {}),
        onServiceConsentRequired: presentSetupServiceConsent,
        onUnmanagedCliConsentRequired: presentUnmanagedCliConsent,
        // The repair changed the runtime these facts describe; re-read rather than keep
        // classifying the state the user just repaired.
        onSucceeded: refreshLocalInspection,
    });
    const repairTaskSnapshot = setupTask.activeTaskSnapshot;
    const isRepairStarting = setupTask.isStarting;

    const setupStart = setupTask.start;
    const handleStartRepair = React.useCallback(async () => {
        if (isRepairUnavailable || isRepairStarting || (repairTaskSnapshot != null && repairTaskSnapshot.result == null)) {
            return;
        }
        // Repair is the same explicit-target executor every other caller starts (SB6), sequenced
        // by the one desktop-side owner, which asks first when the move is an account move (D1).
        await setupStart();
    }, [isRepairStarting, isRepairUnavailable, repairTaskSnapshot, setupStart]);

    const cancelRepair = setupTask.cancel;
    const handleCancelRepair = React.useCallback(() => {
        if (!repairTaskSnapshot || repairTaskSnapshot.result) {
            return;
        }
        cancelRepair();
    }, [cancelRepair, repairTaskSnapshot]);

    const switchToServerUrl = React.useCallback(async (serverUrl: string) => {
        const normalized = String(serverUrl ?? '').trim();
        if (!normalized) {
            return;
        }
        try {
            await upsertActivateAndSwitchServer({
                serverUrl: normalized,
                source: 'url',
                scope: 'device',
                refreshAuth: auth.refreshFromActiveServer,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message.trim() : '';
            Modal.alert(t('common.error'), message || t('server.failedToConnectToServer'));
        }
    }, [auth]);

    return React.useMemo(() => {
        if (!summary) {
            return null;
        }
        const daemonRelayUrl = summary.daemonRelayUrl;
        return {
            kind: 'warning',
            title: summary.title,
            description: summary.description,
            actionLabel: summary.actionLabel,
            ...(isRepairUnavailable
                ? {
                    actionDisabled: true,
                    actionHint: t('settings.systemTaskBridgeUnavailable'),
                }
                : {}),
            onPress: handleStartRepair,
            ...(daemonRelayUrl
                ? {
                    secondaryActionLabel: t('server.switchToServer'),
                    onSecondaryPress: () => switchToServerUrl(daemonRelayUrl),
                }
                : {}),
            isRepairStarting,
            repairTaskSnapshot,
            onCancelRepair: handleCancelRepair,
        } satisfies RelayDriftBanner;
    }, [
        handleCancelRepair,
        handleStartRepair,
        isRepairUnavailable,
        isRepairStarting,
        repairTaskSnapshot,
        summary,
        switchToServerUrl,
    ]);
}
