import { describe, expect, it } from 'vitest';

import {
    deriveDesktopLocalSetupSnapshot,
    type DesktopLocalReadinessFacts,
    type DesktopLocalSetupInput,
} from './deriveDesktopLocalSetupSnapshot';

const RELAY_URL = 'https://relay.example.test';

function readyFacts(overrides: Partial<{
    server: Partial<DesktopLocalReadinessFacts['server']>;
    auth: Partial<DesktopLocalReadinessFacts['auth']>;
    service: Partial<DesktopLocalReadinessFacts['service']>;
    runtimeConvergence: Partial<NonNullable<DesktopLocalReadinessFacts['runtimeConvergence']>> | null;
}> = {}): DesktopLocalReadinessFacts {
    return {
        acquisition: { command: '/home/user/.happier/cli/current/happier', provenance: 'managed' },
        server: {
            serverUrl: RELAY_URL,
            publicServerUrl: RELAY_URL,
            localServerUrl: null,
            comparableKey: 'https://relay.example.test',
            ...overrides.server,
        },
        auth: {
            credentialState: 'valid',
            validatedAccountId: 'acct_app',
            accountId: 'acct_app',
            machineId: 'machine-1',
            ...overrides.auth,
        },
        service: { installed: true, running: true, autostart: null, targetMode: 'default-following', ...overrides.service },
        runtimeConvergence: overrides.runtimeConvergence === null
            ? null
            : {
                controlReachable: true,
                serviceOwnsRunningDaemon: true,
                machineIdMatches: true,
                cliVersionMatches: true,
                ...overrides.runtimeConvergence,
            },
    };
}

function input(overrides: Partial<DesktopLocalSetupInput> = {}): DesktopLocalSetupInput {
    return {
        inspection: { status: 'resolved', facts: readyFacts() },
        expected: { relayUrl: RELAY_URL, localRelayUrl: null, accountId: 'acct_app' },
        ...overrides,
    };
}

describe('deriveDesktopLocalSetupSnapshot', () => {
    it('reveals a machine whose running daemon matches the app relay and account', () => {
        expect(deriveDesktopLocalSetupSnapshot(input({ reachability: 'reachable' }), { authenticatedThisRun: true, hasPresentedShell: false })).toEqual({
            state: 'ready',
            presentation: 'shell',
            reason: null,
        });
    });

    it('never consults an account-wide machine count: a returning user with machines elsewhere and an unconfigured local daemon needs setup (A4)', () => {
        const snapshot = deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    auth: { credentialState: 'missing', validatedAccountId: null, accountId: null, machineId: null },
                    service: { installed: false, running: false },
                    runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false, machineIdMatches: false, cliVersionMatches: false },
                }),
            },
        }), { authenticatedThisRun: true, hasPresentedShell: false });

        expect(snapshot).toEqual({ state: 'setup', presentation: 'ground', reason: 'not_authenticated' });
    });

    it('shows the opaque ground, never a shell frame, while facts are unresolved right after authenticating (B3)', () => {
        expect(deriveDesktopLocalSetupSnapshot(input({ inspection: { status: 'pending' } }), { authenticatedThisRun: true, hasPresentedShell: false })).toEqual({
            state: 'checking',
            presentation: 'ground',
            reason: null,
        });
    });

    it('shows the shell while facts resolve on an ordinary relaunch, then converges under a veil once facts prove the runtime unconfigured (R14)', () => {
        expect(deriveDesktopLocalSetupSnapshot(input({ inspection: { status: 'pending' } }), { authenticatedThisRun: false, hasPresentedShell: false })).toEqual({
            state: 'checking',
            presentation: 'shell',
            reason: null,
        });

        expect(deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    service: { installed: false, running: false },
                    runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false, machineIdMatches: false, cliVersionMatches: false },
                }),
            },
        }), { authenticatedThisRun: false, hasPresentedShell: false })).toEqual({
            state: 'setup',
            presentation: 'veil',
            reason: 'service_not_installed',
        });
    });

    it('treats a healthy daemon on a different relay as setup, not ready', () => {
        const snapshot = deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    server: {
                        serverUrl: 'https://other.example.test',
                        publicServerUrl: 'https://other.example.test',
                        comparableKey: 'https://other.example.test',
                    },
                }),
            },
        }), { authenticatedThisRun: false, hasPresentedShell: false });

        expect(snapshot).toMatchObject({ state: 'setup', reason: 'relay_mismatch' });
    });

    it('treats a healthy daemon validated for a different account as setup, not ready', () => {
        const snapshot = deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({ auth: { validatedAccountId: 'acct_other', accountId: 'acct_other' } }),
            },
        }), { authenticatedThisRun: false, hasPresentedShell: false });

        expect(snapshot).toMatchObject({ state: 'setup', reason: 'account_mismatch' });
    });

    it('accepts the daemon local relay as the same relay when the app also knows that local url', () => {
        const snapshot = deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    server: {
                        serverUrl: 'http://127.0.0.1:3005',
                        publicServerUrl: 'http://127.0.0.1:3005',
                        localServerUrl: null,
                        comparableKey: 'http://127.0.0.1:3005',
                    },
                }),
            },
            expected: { relayUrl: RELAY_URL, localRelayUrl: 'http://127.0.0.1:3005', accountId: 'acct_app' },
            reachability: 'reachable',
        }), { authenticatedThisRun: false, hasPresentedShell: false });

        expect(snapshot).toMatchObject({ state: 'ready' });
    });

    it('does not call a daemon ready from credentials on disk beside a live PID: the running daemon must carry the expected machine id (D1)', () => {
        const snapshot = deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({ runtimeConvergence: { machineIdMatches: false } }),
            },
        }), { authenticatedThisRun: true, hasPresentedShell: false });

        expect(snapshot).toMatchObject({ state: 'setup', presentation: 'ground', reason: 'daemon_not_converged' });
    });

    it.each([
        ['controlReachable', { controlReachable: false }],
        ['serviceOwnsRunningDaemon', { serviceOwnsRunningDaemon: false }],
        ['cliVersionMatches', { cliVersionMatches: false }],
    ] as const)('requires %s from the running daemon', (_label, convergence) => {
        const snapshot = deriveDesktopLocalSetupSnapshot(input({
            inspection: { status: 'resolved', facts: readyFacts({ runtimeConvergence: convergence }) },
        }), { authenticatedThisRun: false, hasPresentedShell: false });

        expect(snapshot).toMatchObject({ state: 'setup', reason: 'daemon_not_converged' });
    });

    it('cannot call a machine ready when the CLI did not describe the running daemon at all', () => {
        const snapshot = deriveDesktopLocalSetupSnapshot(input({
            inspection: { status: 'resolved', facts: readyFacts({ runtimeConvergence: null }) },
        }), { authenticatedThisRun: false, hasPresentedShell: false });

        expect(snapshot).toMatchObject({ state: 'setup', reason: 'runtime_unknown' });
    });

    it('is blocked with a visible retry, not silently ready or silently setup, when the inspection failed', () => {
        expect(deriveDesktopLocalSetupSnapshot(input({
            inspection: { status: 'failed', error: { code: 'cli_spawn_failed', message: 'boom' } },
        }), { authenticatedThisRun: true, hasPresentedShell: false })).toEqual({ state: 'blocked', presentation: 'ground', reason: 'inspection_failed' });

        // A SETTLED failure on a relaunch keeps its error, Details and Retry under the veil. A
        // bare shell would hide the only surface that can recover it, which is how a failed
        // setup became silently permanent (R14).
        expect(deriveDesktopLocalSetupSnapshot(input({
            inspection: { status: 'failed', error: { code: 'cli_spawn_failed', message: 'boom' } },
        }), { authenticatedThisRun: false, hasPresentedShell: false })).toEqual({ state: 'blocked', presentation: 'veil', reason: 'inspection_failed' });
    });

    it('keeps an unverifiable credential check behind the ordinary shell instead of blocking the app (H3)', () => {
        // `unknown` means the CLI could not reach the relay to validate what it has — a transient
        // network fact about the check, not a settled fact about this computer. Nothing is ready,
        // so the state stays `blocked`, but a relaunch must not take the app away over it; the
        // first run has no shell to fall back to, so it keeps the ground.
        const credentialsUnverified = input({
            inspection: { status: 'resolved', facts: readyFacts({ auth: { credentialState: 'unknown', validatedAccountId: null } }) },
        });
        expect(deriveDesktopLocalSetupSnapshot(credentialsUnverified, { authenticatedThisRun: false, hasPresentedShell: false }))
            .toEqual({ state: 'blocked', presentation: 'shell', reason: 'credentials_unverified' });
        expect(deriveDesktopLocalSetupSnapshot(credentialsUnverified, { authenticatedThisRun: false, hasPresentedShell: true }))
            .toEqual({ state: 'blocked', presentation: 'shell', reason: 'credentials_unverified' });
    });

    it('gives the first run a way out of an unverifiable credential check instead of checking forever (F3)', () => {
        // On a relaunch the shell carries this state and the next read clears it. A first run has
        // no shell to fall back to: the opaque ground would show "Checking this computer" with no
        // action, and nothing re-inspects. So it is a settled setup reason there — the executor
        // owns "validate the credentials for this relay" and either pairs or fails by name with a
        // Retry, which is what R14 means by never becoming silently optional.
        const credentialsUnverified = input({
            inspection: { status: 'resolved', facts: readyFacts({ auth: { credentialState: 'unknown', validatedAccountId: null } }) },
        });
        expect(deriveDesktopLocalSetupSnapshot(credentialsUnverified, { authenticatedThisRun: true, hasPresentedShell: false }))
            .toEqual({ state: 'setup', presentation: 'ground', reason: 'credentials_unverified' });
        // A decision the user already made still releases the shell rather than holding the ground.
        expect(deriveDesktopLocalSetupSnapshot(credentialsUnverified, { authenticatedThisRun: true, hasPresentedShell: false, userDeclinedThisAttempt: true }))
            .toEqual({ state: 'setup', presentation: 'shell', reason: 'credentials_unverified' });
    });

    it('keeps an UNSETTLED relaunch check behind the ordinary shell, and only a settled failure takes the veil (R14)', () => {
        // Still reading the facts: nothing is wrong yet, so nothing blocks the app.
        expect(deriveDesktopLocalSetupSnapshot(input({ inspection: { status: 'pending' } }), { authenticatedThisRun: false, hasPresentedShell: true }))
            .toEqual({ state: 'checking', presentation: 'shell', reason: null });
        // Facts converged; the reachability proof is still in flight. Also unsettled.
        expect(deriveDesktopLocalSetupSnapshot(input(), { authenticatedThisRun: false, hasPresentedShell: true }))
            .toEqual({ state: 'checking', presentation: 'shell', reason: 'reachability_pending' });
    });

    it('uses the opaque ground only until the shell has been presented once; later maintenance preserves context under the veil (UD4)', () => {
        // `authenticatedThisRun` stays true for the whole app run, so it cannot mean "the user
        // has not seen the shell yet". Once the shell has rendered, blocking maintenance is the
        // veil over the app the user is already in.
        expect(deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    server: { serverUrl: 'https://other.example.test', publicServerUrl: 'https://other.example.test', comparableKey: 'https://other.example.test' },
                }),
            },
        }), { authenticatedThisRun: true, hasPresentedShell: true }))
            .toEqual({ state: 'setup', presentation: 'veil', reason: 'relay_mismatch' });

        expect(deriveDesktopLocalSetupSnapshot(input({ reachability: 'unreachable' }), { authenticatedThisRun: true, hasPresentedShell: true }))
            .toEqual({ state: 'blocked', presentation: 'veil', reason: 'machine_unreachable' });
    });

    it('never reveals on converged facts alone: the machine has to answer first (INV10)', () => {
        // Convergence describes the daemon this computer is running. It cannot say whether the
        // relay can reach it, so without the read-only machine RPC there is nothing to reveal on.
        expect(deriveDesktopLocalSetupSnapshot(input(), { authenticatedThisRun: true, hasPresentedShell: false }))
            .toEqual({ state: 'checking', presentation: 'ground', reason: 'reachability_pending' });
    });

    it('fails closed on the setup ground when the machine does not answer (INV10)', () => {
        expect(deriveDesktopLocalSetupSnapshot(input({ reachability: 'unreachable' }), { authenticatedThisRun: true, hasPresentedShell: false }))
            .toEqual({ state: 'blocked', presentation: 'ground', reason: 'machine_unreachable' });
        expect(deriveDesktopLocalSetupSnapshot(input({ reachability: 'unreachable' }), { authenticatedThisRun: false, hasPresentedShell: false }))
            .toEqual({ state: 'blocked', presentation: 'veil', reason: 'machine_unreachable' });
    });

    it('needs the app account before it can compare identities', () => {
        expect(deriveDesktopLocalSetupSnapshot(input({
            expected: { relayUrl: RELAY_URL, localRelayUrl: null, accountId: null },
        }), { authenticatedThisRun: true, hasPresentedShell: false })).toEqual({ state: 'checking', presentation: 'ground', reason: null });
    });
    /** An installed, stopped, on-demand service on the relay and account the app is on (H6). */
    function onDemandStoppedInput(overrides: Partial<DesktopLocalSetupInput> = {}): DesktopLocalSetupInput {
        return input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    service: { installed: true, running: false, autostart: 'on-demand' },
                    runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false },
                }),
            },
            ...overrides,
        });
    }

    it('treats an installed on-demand service that is simply not running yet as a check, not a blocking setup (H6)', () => {
        // "Starts when you open the app" is what the user asked for, so the app starting it is
        // not maintenance to be announced: it is an unsettled check, exactly like the reachability
        // proof. Nothing is ready yet and nothing claims to be.
        expect(deriveDesktopLocalSetupSnapshot(onDemandStoppedInput(), { authenticatedThisRun: false, hasPresentedShell: true }))
            .toEqual({ state: 'checking', presentation: 'shell', reason: 'service_start_pending' });
        expect(deriveDesktopLocalSetupSnapshot(onDemandStoppedInput(), { authenticatedThisRun: true, hasPresentedShell: false }))
            .toEqual({ state: 'checking', presentation: 'ground', reason: 'service_start_pending' });
    });

    it('settles the on-demand start once it has had its turn, so the surface carries it instead of checking forever (H6)', () => {
        expect(deriveDesktopLocalSetupSnapshot(
            onDemandStoppedInput({ backgroundServiceStartAttempted: true }),
            { authenticatedThisRun: false, hasPresentedShell: true },
        )).toEqual({ state: 'setup', presentation: 'veil', reason: 'daemon_not_converged' });
    });

    it('never quiet-starts a service for a relay or account the app is not on (H6)', () => {
        // The quiet start is only the on-demand deal being honoured. A daemon configured for
        // another relay needs the executor and the blocking surface, whatever its autostart mode.
        expect(deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    server: { serverUrl: 'https://other.example.test', publicServerUrl: 'https://other.example.test', comparableKey: 'https://other.example.test' },
                    service: { installed: true, running: false, autostart: 'on-demand' },
                    runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false },
                }),
            },
        }), { authenticatedThisRun: false, hasPresentedShell: true }))
            .toEqual({ state: 'setup', presentation: 'veil', reason: 'relay_mismatch' });
    });

    it('does not quiet-start a service the user asked to start at login (H6)', () => {
        // An at-login service that is not running is a real convergence failure, not the
        // on-demand deal: something stopped it, and the veil carries its Retry.
        expect(deriveDesktopLocalSetupSnapshot(input({
            inspection: {
                status: 'resolved',
                facts: readyFacts({
                    service: { installed: true, running: false, autostart: 'at-login' },
                    runtimeConvergence: { controlReachable: false, serviceOwnsRunningDaemon: false },
                }),
            },
        }), { authenticatedThisRun: false, hasPresentedShell: true }))
            .toEqual({ state: 'setup', presentation: 'veil', reason: 'daemon_not_converged' });
    });
});
