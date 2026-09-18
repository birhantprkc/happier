import { describe, expect, it } from 'vitest';

import type { DesktopLocalInspection, DesktopLocalReadinessFacts } from './deriveDesktopLocalSetupSnapshot';
import { appOwnedServiceContradictsTarget, resolveRelayReconciliationConsent } from './relayReconciliationConsent';

function facts(overrides: Partial<{
    serverUrl: string;
    installed: boolean;
    running: boolean;
    targetMode: DesktopLocalReadinessFacts['service']['targetMode'];
    serviceOwnsRunningDaemon: boolean;
    validatedAccountId: string | null;
    runtimeConvergence: DesktopLocalReadinessFacts['runtimeConvergence'];
}> = {}): DesktopLocalReadinessFacts {
    const owns = overrides.serviceOwnsRunningDaemon ?? true;
    return {
        acquisition: { command: '/managed/happier', provenance: 'managed' },
        server: {
            serverUrl: overrides.serverUrl ?? 'https://old.relay.test',
            publicServerUrl: null,
            localServerUrl: null,
            comparableKey: null,
        },
        auth: {
            credentialState: 'valid',
            validatedAccountId: overrides.validatedAccountId === undefined ? 'acct_app' : overrides.validatedAccountId,
            accountId: 'acct_app',
            machineId: 'machine-1',
        },
        service: {
            installed: overrides.installed ?? true,
            running: overrides.running ?? true,
            autostart: null,
            targetMode: overrides.targetMode === undefined ? 'default-following' : overrides.targetMode,
        },
        runtimeConvergence: overrides.runtimeConvergence === undefined
            ? {
                controlReachable: true,
                serviceOwnsRunningDaemon: owns,
                machineIdMatches: true,
                cliVersionMatches: true,
            }
            : overrides.runtimeConvergence,
    };
}

function resolved(overrides?: Parameters<typeof facts>[0]): DesktopLocalInspection {
    return { status: 'resolved', facts: facts(overrides) };
}

const OBSERVED = { relayUrl: 'https://old.relay.test', localRelayUrl: null, accountId: 'acct_app' };

describe('resolveRelayReconciliationConsent (UD5)', () => {
    it('is silent when the app\'s own default-following service is where the app last put it', () => {
        expect(resolveRelayReconciliationConsent({
            inspection: resolved(),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('start');
    });

    it('asks when the daemon sits on a relay the app did not put it on', () => {
        expect(resolveRelayReconciliationConsent({
            inspection: resolved({ serverUrl: 'https://someone-elses.relay.test' }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('confirm');
    });

    it('asks when the daemon runs as an account the app did not expect', () => {
        expect(resolveRelayReconciliationConsent({
            inspection: resolved({ validatedAccountId: 'acct_other' }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('confirm');
    });

    it('installs silently when there is no service of this installation to move', () => {
        // A first install is not a relay move, so nothing is asked. Conflicts with a service this
        // installation does not own at all are classified by `service install --dry-run --json`,
        // and the executor raises that consent itself (INV9).
        expect(resolveRelayReconciliationConsent({
            inspection: resolved({ serverUrl: 'https://someone-elses.relay.test', installed: false, targetMode: null, serviceOwnsRunningDaemon: false }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('start');
    });

    it('asks before moving this installation\'s own service even when no daemon is running for it (F2)', () => {
        // The stopped on-demand lifecycle: the app-close guard stopped the service, a notification
        // had moved the app to another relay, and the relaunch reaches here. Requiring a RUNNING
        // owned daemon before comparing relays read this as "nothing of ours to move" and repointed
        // it silently — INV7 across a relaunch, for the very mode this program shipped. The
        // definition is the app's whether or not a process is up for it.
        expect(resolveRelayReconciliationConsent({
            inspection: resolved({
                serverUrl: 'https://old.relay.test',
                running: false,
                serviceOwnsRunningDaemon: false,
            }),
            observedExpectation: { ...OBSERVED, relayUrl: 'https://new.relay.test' },
            alwaysMoveDefaultFollowingService: false,
        })).toBe('confirm');

        // The remembered device preference still applies to exactly this compatible case.
        expect(resolveRelayReconciliationConsent({
            inspection: resolved({
                serverUrl: 'https://old.relay.test',
                running: false,
                serviceOwnsRunningDaemon: false,
            }),
            observedExpectation: { ...OBSERVED, relayUrl: 'https://new.relay.test' },
            alwaysMoveDefaultFollowingService: true,
        })).toBe('start');
    });

    it('agrees with the gate about what counts as this installation\'s service (F2)', () => {
        // Two predicates for one concept disagreed in this file: the gate routed a stopped service
        // to reconciliation because its mode was known, and reconciliation then started without
        // asking because no daemon was running for it. One predicate, one answer.
        const stoppedElsewhere = resolved({
            serverUrl: 'https://old.relay.test',
            running: false,
            serviceOwnsRunningDaemon: false,
        });
        const target = { relayUrl: 'https://new.relay.test', localRelayUrl: null, accountId: 'acct_app' };

        expect(appOwnedServiceContradictsTarget({ inspection: stoppedElsewhere, target })).toBe(true);
        expect(resolveRelayReconciliationConsent({
            inspection: stoppedElsewhere,
            observedExpectation: target,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('confirm');
    });

    it('lets the device preference suppress only the compatible default-following ask', () => {
        expect(resolveRelayReconciliationConsent({
            inspection: resolved({ serverUrl: 'https://someone-elses.relay.test' }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('start');
    });

    it('asks when the facts are unknown', () => {
        expect(resolveRelayReconciliationConsent({
            inspection: { status: 'pending' },
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm');
        expect(resolveRelayReconciliationConsent({
            inspection: resolved({ runtimeConvergence: null }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm');
        expect(resolveRelayReconciliationConsent({
            inspection: resolved(),
            observedExpectation: null,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm');
    });

    it('does not contradict an app that had no account expectation when it looked', () => {
        expect(resolveRelayReconciliationConsent({
            inspection: resolved(),
            observedExpectation: { ...OBSERVED, accountId: null },
            alwaysMoveDefaultFollowingService: false,
        })).toBe('start');
    });

    it('never moves a pinned service silently, and never honours the remembered preference for one', () => {
        // A pinned service was deliberately fixed to one relay; following the app's selected
        // default is not its contract. The status projection carried no mode, so an installed
        // service whose running daemon its own installation owned read as default-following —
        // which let the aligned case move it with no ask at all, and let the remembered "always
        // move my default-following service" move it even when nothing aligned.
        expect(resolveRelayReconciliationConsent({
            inspection: resolved({ targetMode: 'pinned' }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('confirm');
        expect(resolveRelayReconciliationConsent({
            inspection: resolved({ targetMode: 'pinned', serverUrl: 'https://someone-elses.relay.test' }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm');
    });

    it('asks before moving an installed service whose target mode nothing proved', () => {
        // `null` is UNKNOWN — an older CLI, or a service definition that proved no mode. It is
        // never evidence that the service is the app's to move, and the device preference must not
        // reach past it.
        expect(resolveRelayReconciliationConsent({
            inspection: resolved({ targetMode: null }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('confirm');
        expect(resolveRelayReconciliationConsent({
            inspection: resolved({ targetMode: null }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm');
    });

    it('asks before moving an installed service that is merely stopped, exactly as it would a running one (F8)', () => {
        // A stopped service has no running daemon for its installation to own, so the ownership
        // test alone read it as "not the app's at all" and moved it with no ask. What it IS did
        // not change when it stopped: a pinned definition is still pinned, and an unproven mode is
        // still unproven. Stopping is not consent.
        expect(resolveRelayReconciliationConsent({
            inspection: resolved({ targetMode: 'pinned', running: false, serviceOwnsRunningDaemon: false }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm');
        expect(resolveRelayReconciliationConsent({
            inspection: resolved({ targetMode: null, running: false, serviceOwnsRunningDaemon: false }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm');
    });

    it('does not ask about an unknown target mode when there is no service installed to move', () => {
        // Nothing installed reports no mode either, and a first install is not a relay move.
        expect(resolveRelayReconciliationConsent({
            inspection: resolved({ installed: false, targetMode: null }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('start');
    });
});

describe('appOwnedServiceContradictsTarget (B2)', () => {
    const TARGET = { relayUrl: 'https://new.relay.test', localRelayUrl: null, accountId: 'acct_app' };

    it('reports a service this app owns that is on another relay than the app', () => {
        expect(appOwnedServiceContradictsTarget({ inspection: resolved(), target: TARGET })).toBe(true);
    });

    it('reports an installed service with a known mode even when nothing is running to own (F8)', () => {
        expect(appOwnedServiceContradictsTarget({
            inspection: resolved({ targetMode: 'pinned', running: false, serviceOwnsRunningDaemon: false }),
            target: TARGET,
        })).toBe(true);
    });

    it('reports a service validated for an account the app is not on', () => {
        expect(appOwnedServiceContradictsTarget({
            inspection: resolved({ serverUrl: 'https://new.relay.test', validatedAccountId: 'acct_other' }),
            target: TARGET,
        })).toBe(true);
    });

    it('says nothing about a computer with no service installed: a first install moves nothing', () => {
        expect(appOwnedServiceContradictsTarget({
            inspection: resolved({ installed: false, targetMode: null, serviceOwnsRunningDaemon: false }),
            target: TARGET,
        })).toBe(false);
    });

    it('says nothing when the service is already where the app is going', () => {
        expect(appOwnedServiceContradictsTarget({
            inspection: resolved({ serverUrl: 'https://new.relay.test' }),
            target: TARGET,
        })).toBe(false);
    });

    it('says nothing about facts it does not have', () => {
        expect(appOwnedServiceContradictsTarget({ inspection: { status: 'pending' }, target: TARGET })).toBe(false);
    });
});
