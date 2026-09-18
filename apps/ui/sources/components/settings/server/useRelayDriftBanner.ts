import * as React from 'react';

import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import { useThisComputerSetupTask } from '@/components/systemTasks/useThisComputerSetupTask';
import { usePrimaryMachineFromActiveSelection } from '@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection';
import { desktopSetupCoordinator } from '@/setup/desktopSetupCoordinator';
import { presentSetupServiceConsent } from '@/setup/presentSetupServiceConsent';
import { presentUnmanagedCliConsent } from '@/setup/presentUnmanagedCliConsent';
import { useDesktopLocalInspection } from '@/setup/useDesktopLocalInspection';
import { daemonNeedsAuthFromFacts, type DesktopLocalInspection } from '@/setup/deriveDesktopLocalSetupSnapshot';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { readCachedMachineDoctorSnapshot } from '@/components/settings/systemStatus/cache/machineDoctorSnapshotCache';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { useAuth } from '@/auth/context/AuthContext';
import { Modal } from '@/modal';
import { t } from '@/text';
import { classifyRelayDrift, createRelayUrlComparableKeySafe, resolveKnownRelayEquivalentUrl } from '@/sync/domains/server/relayDrift/relayDriftModel';
import type { RelayDriftBanner } from './relayDriftTypes';

/**
 * What the classifier needs to know about a daemon. On desktop these come from the ambient
 * local inspection (the running daemon); elsewhere from the remote doctor cache (SB2).
 */
type DaemonDriftFacts = Readonly<{
    relayUrl: string | null;
    alternateRelayUrls: readonly (string | null)[];
    accountId: string | null;
    /**
     * The app's own account, when the daemon account above is comparable with it. Only the local
     * inspection supplies one: it is the relay-validated account of the daemon on THIS computer,
     * which is the one the app could be contradicting. The doctor cache describes another machine
     * through a different field and stays exactly as it was (SB2).
     */
    appAccountId: string | null;
    needsAuth: boolean | undefined;
    serviceInstalled: boolean | undefined;
    running: boolean | undefined;
}>;

function daemonFactsFromLocalInspection(
    inspection: DesktopLocalInspection,
    appAccountId: string | null,
): DaemonDriftFacts | null {
    if (inspection.status !== 'resolved') {
        return null;
    }
    const facts = inspection.facts;
    const controlReachable = facts.runtimeConvergence?.controlReachable ?? false;
    // R10 — knowing a daemon means one exists here: an installed background service, or a daemon
    // answering control. A computer with neither has nothing that could have drifted, and the
    // relay in the CLI's config file is a default, not knowledge of a daemon. Acquiring the first
    // daemon belongs to the setup gate (R2/R14), and the neutral local-daemon status already
    // states the fact, so a warning here would only nag about an ordinary first-run state.
    if (!facts.service.installed && !controlReachable) {
        return null;
    }
    return {
        relayUrl: facts.server.serverUrl,
        alternateRelayUrls: [facts.server.publicServerUrl, facts.server.localServerUrl],
        accountId: facts.auth.validatedAccountId,
        appAccountId,
        needsAuth: daemonNeedsAuthFromFacts(facts),
        serviceInstalled: facts.service.installed,
        running: controlReachable,
    };
}

function daemonFactsFromDoctorSnapshot(cachedDoctorSnapshot: ReturnType<typeof readCachedMachineDoctorSnapshot>): DaemonDriftFacts | null {
    if (!cachedDoctorSnapshot) {
        return null;
    }
    const daemonSnapshot = cachedDoctorSnapshot.snapshot.daemonStatus;
    return {
        relayUrl: daemonSnapshot?.server.serverUrl ?? cachedDoctorSnapshot.snapshot.server.serverUrl ?? null,
        alternateRelayUrls: [daemonSnapshot?.server.publicServerUrl ?? cachedDoctorSnapshot.snapshot.server.publicServerUrl ?? null],
        accountId: daemonSnapshot?.auth.accountId ?? cachedDoctorSnapshot.snapshot.accountId ?? null,
        appAccountId: null,
        needsAuth: daemonSnapshot?.auth.needsAuth,
        serviceInstalled: daemonSnapshot?.service.installed,
        running: daemonSnapshot?.service.running,
    };
}

function readAppSameOriginRelayUrl(): string | null {
    const currentOrigin = typeof window !== 'undefined'
        ? window.location?.origin
        : (globalThis as typeof globalThis & { location?: { origin?: string } }).location?.origin;
    const normalizedOrigin = typeof currentOrigin === 'string' ? currentOrigin.trim() : '';
    return normalizedOrigin || null;
}

function resolveDoctorLocalRelayCandidate(params: Readonly<{
    activeRelayUrl: string;
    doctorSnapshot: ReturnType<typeof readCachedMachineDoctorSnapshot>;
}>): string | null {
    const doctorServer = params.doctorSnapshot?.snapshot.server;
    if (!doctorServer) {
        return null;
    }

    const activeRelayKey = createRelayUrlComparableKeySafe(params.activeRelayUrl);
    if (!activeRelayKey) {
        return null;
    }
    const doctorPublicRelayKey = createRelayUrlComparableKeySafe(doctorServer.publicServerUrl);
    const doctorServerUrl = typeof doctorServer.serverUrl === 'string' ? doctorServer.serverUrl.trim() : '';
    const knownPair = doctorPublicRelayKey
        ? resolveKnownRelayEquivalentUrl({
            activeRelayUrl: params.activeRelayUrl,
            daemonRelayUrl: doctorServerUrl,
            daemonAlternateRelayUrls: [doctorServer.publicServerUrl],
        })
        : null;
    if (knownPair) {
        return knownPair;
    }

    const appSameOriginRelayKey = createRelayUrlComparableKeySafe(readAppSameOriginRelayUrl());
    const candidates = [doctorServer.serverUrl, doctorServer.webappUrl];
    for (const candidate of candidates) {
        const normalizedCandidate = typeof candidate === 'string' ? candidate.trim() : '';
        if (!normalizedCandidate) continue;
        const candidateKey = createRelayUrlComparableKeySafe(normalizedCandidate);
        if (!candidateKey || candidateKey === activeRelayKey) continue;
        if (!doctorPublicRelayKey && appSameOriginRelayKey && appSameOriginRelayKey === candidateKey) {
            return normalizedCandidate;
        }
    }

    return null;
}

export function useRelayDriftBanner(): RelayDriftBanner | null {
    const auth = useAuth();
    const primaryMachineId = usePrimaryMachineFromActiveSelection();
    const activeServerSnapshot = getActiveServerSnapshot();
    const runner = React.useMemo(() => getDefaultSystemTaskRunner(), []);
    const desktop = isTauriDesktop();
    const { inspection: localInspection, refresh: refreshLocalInspection } = useDesktopLocalInspection(desktop);
    const isRepairUnavailable = runner.mode === 'unavailable';

    const cachedDoctorSnapshot = React.useMemo(() => {
        if (desktop || !primaryMachineId || !activeServerSnapshot.serverId) {
            return null;
        }
        return readCachedMachineDoctorSnapshot({
            serverId: activeServerSnapshot.serverId,
            machineId: primaryMachineId,
        });
    }, [activeServerSnapshot.serverId, desktop, primaryMachineId]);

    // The account this repair is for, read from the same owner the executor spec is built from, so
    // the app never approves a pairing bound to a different account (INV2). It is also what the
    // daemon's own validated account is compared against (F7).
    const expectedAccountId = getActiveServerAccountScope()?.accountId ?? null;

    const daemonFacts = React.useMemo(
        () => (desktop
            ? daemonFactsFromLocalInspection(localInspection, expectedAccountId)
            : daemonFactsFromDoctorSnapshot(cachedDoctorSnapshot)),
        [cachedDoctorSnapshot, desktop, expectedAccountId, localInspection],
    );
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

    const activeLocalRelayUrl = React.useMemo(() => {
        if (typeof activeServerSnapshot.activeLocalRelayUrl === 'string' && activeServerSnapshot.activeLocalRelayUrl.trim().length > 0) {
            return activeServerSnapshot.activeLocalRelayUrl.trim();
        }

        const doctorLocalRelayUrl = resolveDoctorLocalRelayCandidate({
            activeRelayUrl: activeServerSnapshot.serverUrl,
            doctorSnapshot: cachedDoctorSnapshot,
        });
        if (doctorLocalRelayUrl) {
            return doctorLocalRelayUrl;
        }

        const appSameOriginRelayUrl = readAppSameOriginRelayUrl();
        if (!appSameOriginRelayUrl) {
            return null;
        }

        if (createRelayUrlComparableKeySafe(appSameOriginRelayUrl) === createRelayUrlComparableKeySafe(activeServerSnapshot.serverUrl)) {
            return null;
        }

        return appSameOriginRelayUrl;
    }, [activeServerSnapshot.activeLocalRelayUrl, activeServerSnapshot.serverUrl, cachedDoctorSnapshot]);
    const setupStart = setupTask.start;
    const handleStartRepair = React.useCallback(async () => {
        if (isRepairUnavailable || isRepairStarting || (repairTaskSnapshot != null && repairTaskSnapshot.result == null)) {
            return;
        }
        // Repair is the same explicit-target executor every other caller starts (SB6), sequenced
        // by the one desktop-side owner.
        await desktopSetupCoordinator.startSetup({ start: setupStart });
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
        // R10: no daemon knowledge, no banner — on desktop the facts are the local inspection,
        // and a first-run machine has none until it resolves.
        if (!daemonFacts) {
            return null;
        }
        const classification = classifyRelayDrift({
            activeRelayUrl: activeServerSnapshot.serverUrl,
            activeLocalRelayUrl,
            daemonRelayUrl: daemonFacts.relayUrl,
            daemonAlternateRelayUrls: daemonFacts.alternateRelayUrls,
            daemonAccountId: daemonFacts.accountId,
            appAccountId: daemonFacts.appAccountId,
            daemonNeedsAuth: daemonFacts.needsAuth,
            daemonServiceInstalled: daemonFacts.serviceInstalled,
            daemonRunning: daemonFacts.running,
        });

        if (classification.status === 'aligned' || classification.repairAction == null) {
            return null;
        }

        const daemonRelayUrl = daemonFacts.relayUrl;
        const activeRelayLabel = toServerUrlDisplay(activeServerSnapshot.serverUrl);
        const daemonRelayLabel = daemonRelayUrl ? toServerUrlDisplay(daemonRelayUrl) : null;

        const description = classification.status === 'daemon_url_mismatch'
            ? t('server.relayDrift.bannerDifferentRelayDescription', {
                activeRelayUrl: activeRelayLabel,
                daemonRelayUrl: daemonRelayLabel ?? t('server.relayDrift.statusUnknown'),
            })
            : classification.status === 'daemon_not_installed'
                ? t('server.relayDrift.bannerNotInstalledDescription', { activeRelayUrl: activeRelayLabel })
                : classification.status === 'daemon_not_running'
                    ? t('server.relayDrift.bannerNotRunningDescription', { activeRelayUrl: activeRelayLabel })
            : classification.status === 'daemon_account_mismatch'
                // The same repair as the needs-auth case, but not the same fact: this service IS
                // signed in — as somebody else — so saying it "needs to sign in" would be untrue.
                ? t('server.relayDrift.bannerAccountMismatchDescription', { activeRelayUrl: activeRelayLabel })
            : classification.status === 'daemon_needs_auth'
                ? t('server.relayDrift.bannerNeedsAuthDescription', { activeRelayUrl: activeRelayLabel })
                : t('server.relayDrift.bannerNotConfiguredDescription', { activeRelayUrl: activeRelayLabel });

        return {
            kind: 'warning',
            title: classification.status === 'daemon_url_mismatch'
                ? t('server.relayDrift.bannerDifferentRelayTitle')
                : classification.status === 'daemon_not_installed'
                    ? t('server.relayDrift.bannerNotInstalledTitle')
                    : classification.status === 'daemon_not_running'
                        ? t('server.relayDrift.bannerNotRunningTitle')
                : classification.status === 'daemon_account_mismatch'
                    ? t('server.relayDrift.bannerAccountMismatchTitle')
                : classification.status === 'daemon_needs_auth'
                    ? t('server.relayDrift.bannerNeedsAuthTitle')
                    : t('server.relayDrift.bannerNotConfiguredTitle'),
            description,
            actionLabel: classification.status === 'daemon_needs_auth' || classification.status === 'daemon_account_mismatch'
                ? t('common.authenticate')
                : t('server.relayDrift.repairAction'),
            ...(isRepairUnavailable
                ? {
                    actionDisabled: true,
                    actionHint: t('settings.systemTaskBridgeUnavailable'),
                }
                : {}),
            onPress: handleStartRepair,
            ...(classification.status === 'daemon_url_mismatch' && daemonRelayUrl
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
        activeServerSnapshot.serverUrl,
        activeLocalRelayUrl,
        daemonFacts,
        handleCancelRepair,
        handleStartRepair,
        isRepairUnavailable,
        isRepairStarting,
        repairTaskSnapshot,
        switchToServerUrl,
    ]);
}
