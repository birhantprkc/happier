import { describe, expect, it } from 'vitest';

import type { DesktopLocalInspection, DesktopLocalReadinessFacts } from './deriveDesktopLocalSetupSnapshot';
import {
    daemonContradictsTarget,
    identifyKeptBackgroundService,
    keptBackgroundServiceApplies,
    resolveRelayReconciliationConsent,
} from './relayReconciliationConsent';

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
        acquisition: { command: '/managed/happier', provenance: 'managed', version: null, channel: null },
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
            accountLabel: null,
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
        cliUpdate: null,
        cliChoice: { mode: null, otherCli: null },
    };
}

function resolved(overrides?: Parameters<typeof facts>[0]): DesktopLocalInspection {
    return { status: 'resolved', facts: facts(overrides) };
}

const OBSERVED = { relayUrl: 'https://old.relay.test', localRelayUrl: null, accountId: 'acct_app' };
/** Where the app is taking this computer: the relay the user moved to, on the app's account. */
const MOVE_TARGET = { relayUrl: 'https://new.relay.test', localRelayUrl: null, accountId: 'acct_app' };

describe('resolveRelayReconciliationConsent (UD5)', () => {
    it('is silent when the app\'s own default-following service is where the app last put it', () => {
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
            inspection: resolved(),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('start');
    });

    it('asks when the daemon sits on a relay the app did not put it on', () => {
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
            inspection: resolved({ serverUrl: 'https://someone-elses.relay.test' }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('confirm_relay');
    });

    it('asks the account question when the daemon runs as an account the app is not on (D1)', () => {
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
            inspection: resolved({ validatedAccountId: 'acct_other' }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('confirm_account');
    });

    it('asks nothing about a daemon already on the relay the app is going to (no move to name)', () => {
        expect(resolveRelayReconciliationConsent({
            target: { ...MOVE_TARGET, relayUrl: 'https://old.relay.test' },
            inspection: resolved({ targetMode: 'pinned' }),
            observedExpectation: { ...OBSERVED, relayUrl: 'https://elsewhere.relay.test' },
            alwaysMoveDefaultFollowingService: false,
        })).toBe('start');
    });

    it('never lets "always move" cover an account move (D1)', () => {
        expect(resolveRelayReconciliationConsent({
            target: { ...MOVE_TARGET, relayUrl: 'https://old.relay.test' },
            inspection: resolved({ validatedAccountId: 'acct_other' }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm_account');
    });

    it('compares the account against where the app is NOW, not the identity it first observed (U1)', () => {
        // Sign out of A, sign in to C in the same run: the observation still says A, and so does
        // the daemon. Measured against the observation nothing contradicted anything, so the
        // executor re-paired this computer to C with no question and A silently lost it.
        expect(resolveRelayReconciliationConsent({
            target: { relayUrl: 'https://old.relay.test', localRelayUrl: null, accountId: 'acct_c' },
            inspection: resolved({ validatedAccountId: 'acct_a' }),
            observedExpectation: { ...OBSERVED, accountId: 'acct_a' },
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm_account');
    });

    it('asks the account question for a CLI signed in from the terminal with no service of the app\'s (U3)', () => {
        expect(resolveRelayReconciliationConsent({
            target: { ...MOVE_TARGET, relayUrl: 'https://old.relay.test' },
            inspection: resolved({ installed: false, targetMode: null, serviceOwnsRunningDaemon: false, validatedAccountId: 'acct_terminal' }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm_account');
    });

    it('installs silently when there is no service of this installation to move', () => {
        // A first install is not a relay move, so nothing is asked. Conflicts with a service this
        // installation does not own at all are classified by `service install --dry-run --json`,
        // and the executor raises that consent itself (INV9).
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
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
            target: MOVE_TARGET,
            inspection: resolved({
                serverUrl: 'https://old.relay.test',
                running: false,
                serviceOwnsRunningDaemon: false,
            }),
            observedExpectation: { ...OBSERVED, relayUrl: 'https://new.relay.test' },
            alwaysMoveDefaultFollowingService: false,
        })).toBe('confirm_relay');

        // The remembered device preference still applies to exactly this compatible case.
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
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

        expect(daemonContradictsTarget({ inspection: stoppedElsewhere, target })).toBe(true);
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
            inspection: stoppedElsewhere,
            observedExpectation: target,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('confirm_relay');
    });

    it('lets the device preference suppress only the compatible default-following ask', () => {
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
            inspection: resolved({ serverUrl: 'https://someone-elses.relay.test' }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('start');
    });

    it('asks when the facts are unknown', () => {
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
            inspection: { status: 'pending' },
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm_relay');
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
            inspection: resolved({ runtimeConvergence: null }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm_relay');
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
            inspection: resolved(),
            observedExpectation: null,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm_relay');
    });

    it('does not contradict an app that had no account expectation when it looked', () => {
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
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
            target: MOVE_TARGET,
            inspection: resolved({ targetMode: 'pinned' }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('confirm_relay');
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
            inspection: resolved({ targetMode: 'pinned', serverUrl: 'https://someone-elses.relay.test' }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm_relay');
    });

    it('asks before moving an installed service whose target mode nothing proved', () => {
        // `null` is UNKNOWN — an older CLI, or a service definition that proved no mode. It is
        // never evidence that the service is the app's to move, and the device preference must not
        // reach past it.
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
            inspection: resolved({ targetMode: null }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('confirm_relay');
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
            inspection: resolved({ targetMode: null }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm_relay');
    });

    it('asks before moving an installed service that is merely stopped, exactly as it would a running one (F8)', () => {
        // A stopped service has no running daemon for its installation to own, so the ownership
        // test alone read it as "not the app's at all" and moved it with no ask. What it IS did
        // not change when it stopped: a pinned definition is still pinned, and an unproven mode is
        // still unproven. Stopping is not consent.
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
            inspection: resolved({ targetMode: 'pinned', running: false, serviceOwnsRunningDaemon: false }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm_relay');
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
            inspection: resolved({ targetMode: null, running: false, serviceOwnsRunningDaemon: false }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: true,
        })).toBe('confirm_relay');
    });

    it('does not ask about an unknown target mode when there is no service installed to move', () => {
        // Nothing installed reports no mode either, and a first install is not a relay move.
        expect(resolveRelayReconciliationConsent({
            target: MOVE_TARGET,
            inspection: resolved({ installed: false, targetMode: null }),
            observedExpectation: OBSERVED,
            alwaysMoveDefaultFollowingService: false,
        })).toBe('start');
    });
});

describe('daemonContradictsTarget (B2)', () => {
    const TARGET = { relayUrl: 'https://new.relay.test', localRelayUrl: null, accountId: 'acct_app' };

    it('reports a service this app owns that is on another relay than the app', () => {
        expect(daemonContradictsTarget({ inspection: resolved(), target: TARGET })).toBe(true);
    });

    it('reports an installed service with a known mode even when nothing is running to own (F8)', () => {
        expect(daemonContradictsTarget({
            inspection: resolved({ targetMode: 'pinned', running: false, serviceOwnsRunningDaemon: false }),
            target: TARGET,
        })).toBe(true);
    });

    it('reports a service validated for an account the app is not on', () => {
        expect(daemonContradictsTarget({
            inspection: resolved({ serverUrl: 'https://new.relay.test', validatedAccountId: 'acct_other' }),
            target: TARGET,
        })).toBe(true);
    });

    it('says nothing about a computer with no service installed: a first install moves nothing', () => {
        expect(daemonContradictsTarget({
            inspection: resolved({ installed: false, targetMode: null, serviceOwnsRunningDaemon: false }),
            target: TARGET,
        })).toBe(false);
    });

    it('says nothing when the service is already where the app is going', () => {
        expect(daemonContradictsTarget({
            inspection: resolved({ serverUrl: 'https://new.relay.test' }),
            target: TARGET,
        })).toBe(false);
    });

    it('says nothing about facts it does not have', () => {
        expect(daemonContradictsTarget({ inspection: { status: 'pending' }, target: TARGET })).toBe(false);
    });

    it('reports a CLI validated for another account even when the app owns no service here (U3)', () => {
        expect(daemonContradictsTarget({
            inspection: resolved({
                serverUrl: 'https://new.relay.test',
                installed: false,
                targetMode: null,
                serviceOwnsRunningDaemon: false,
                validatedAccountId: 'acct_terminal',
            }),
            target: TARGET,
        })).toBe(true);
    });
});

describe('keptBackgroundServiceApplies (D5)', () => {
    const TARGET = { relayUrl: 'https://new.relay.test', localRelayUrl: null, accountId: 'acct_app' };
    const elsewhere = resolved({ serverUrl: 'https://old.relay.test', validatedAccountId: 'acct_other' });

    it('holds for the daemon the user chose to keep while it still contradicts the app', () => {
        const kept = identifyKeptBackgroundService(elsewhere);
        expect(kept).not.toBeNull();
        expect(keptBackgroundServiceApplies({ inspection: elsewhere, target: TARGET, kept })).toBe(true);
    });

    it('stops holding once the daemon is somewhere else, or signed in as someone else', () => {
        const kept = identifyKeptBackgroundService(elsewhere);
        expect(keptBackgroundServiceApplies({
            inspection: resolved({ serverUrl: 'https://third.relay.test', validatedAccountId: 'acct_other' }),
            target: TARGET,
            kept,
        })).toBe(false);
        expect(keptBackgroundServiceApplies({
            inspection: resolved({ serverUrl: 'https://old.relay.test', validatedAccountId: 'acct_third' }),
            target: TARGET,
            kept,
        })).toBe(false);
    });

    it('never holds for a daemon that is already the app\'s', () => {
        const ours = resolved({ serverUrl: 'https://new.relay.test' });
        expect(keptBackgroundServiceApplies({ inspection: ours, target: TARGET, kept: identifyKeptBackgroundService(ours) })).toBe(false);
    });

    it('holds for nothing when nothing was kept or nothing is known', () => {
        expect(keptBackgroundServiceApplies({ inspection: elsewhere, target: TARGET, kept: null })).toBe(false);
        expect(identifyKeptBackgroundService({ status: 'pending' })).toBeNull();
    });
});
