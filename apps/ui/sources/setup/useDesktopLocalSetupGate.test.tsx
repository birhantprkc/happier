import type { SetupCliChoicePromptPayload } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import type { DesktopLocalInspection } from './deriveDesktopLocalSetupSnapshot';
import type { DesktopLocalSetupGate } from './useDesktopLocalSetupGate';

const state = vi.hoisted(() => ({
    activeServer: {
        serverId: 'custom-2',
        serverUrl: 'https://relay.example.test',
        activeLocalRelayUrl: null as string | null,
        generation: 1,
    },
    accountId: 'acct_app' as string | null,
    settings: {
        serverSelectionActiveTargetKind: 'server' as 'server' | 'group' | null,
        serverSelectionActiveTargetId: 'custom-2' as string | null,
    },
    storageListeners: new Set<() => void>(),
    observed: { serverId: 'custom-2', relayUrl: 'https://relay.example.test', localRelayUrl: null, accountId: 'acct_app' } as unknown,
    /** The relay the user directly chose in this app run, if any (R8/INV7). */
    directRelaySelectionIntent: null as string | null,
    /** How many direct Relay/Home picks the person has made in this app run (B1). */
    intentGeneration: 0,
    reconcileOutcome: { taskId: 'task_setup_1' } as unknown,
    authenticatedThisRun: false,
    /** The executor's `onSucceeded`, so a test can complete the run the gate started. */
    onSetupSucceeded: null as ((run: unknown) => void) | null,
    /** Everything the gate wired into the one setup task, so a test can drive its callbacks. */
    setupTaskOptions: null as SetupTaskOptionsProbe | null,
    /** The setup task's run, as the task hook would report it. */
    setupTaskSnapshot: null as unknown,
    /** D5 — the daemon this device chose to keep as it is. */
    keptBackgroundService: null as { relayKey: string; accountId: string | null } | null,
}));

/**
 * The coordinator's one published observation (F6). Readers render the snapshot and re-render when
 * it changes, so this fake keeps the same shape rather than handing each caller a promise.
 */
const inspectionStore = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const notify = () => {
        for (const listener of Array.from(listeners)) listener();
    };
    return {
        value: { status: 'pending' } as unknown,
        refreshing: false,
        listeners,
        /** A read starting: the established facts stay put, the in-flight fact goes up. */
        beginRead() {
            this.refreshing = true;
            notify();
        },
        publish(next: unknown) {
            this.refreshing = false;
            this.value = next;
            notify();
        },
        reset() {
            this.value = { status: 'pending' };
            this.refreshing = false;
            listeners.clear();
        },
    };
});

/** The direct-selection intent's subscribers (B1). */
const intentListeners = vi.hoisted(() => new Set<() => void>());

const spies = vi.hoisted(() => ({
    startSetup: vi.fn(async () => ({ taskId: 'task_setup_1' })),
    reconcile: vi.fn(async () => state.reconcileOutcome),
    inspect: vi.fn(async () => ({ status: 'pending' }) as DesktopLocalInspection),
    /** The one read-only proof that this daemon answers now (INV10). */
    machineRpc: vi.fn(async (_params: unknown) => ({ ok: true }) as unknown),
    /** H6 — the existing `daemon.service.start.v1` command, run as a check rather than as setup. */
    startBackgroundService: vi.fn(async () => {}),
    /** The one ask before an override CLI is handed the account content key. */
    presentUnmanagedCliConsent: vi.fn(async (_decision: Readonly<{ cliCommand: string | null }>) => false),
    /** R12's one-CLI question — a modal, the presentation boundary. */
    presentCliChoice: vi.fn(async (_prompt: unknown): Promise<'managed' | 'own' | null> => null),
    /** UD5's service-ownership ask, raised by the executor through the CLI's own preview. */
    presentSetupServiceConsent: vi.fn(async (_prompt: unknown) => true),
    /** The coordinator's one readiness proof (INV8 + INV10). */
    verifyCurrentTarget: vi.fn(async (_options?: Readonly<{ fresh?: boolean }>) => ({ status: 'verified' }) as unknown),
    /**
     * R8/INV7 — the direct Relay/Home action's one-shot fact. Backed here by the same single slot
     * the real owner keeps, so the gate's "consumed once, never replayed" contract is observable
     * without importing the module's own state into this file.
     */
    consumeDirectRelaySelectionIntent: vi.fn((serverId: string) => {
        if (state.directRelaySelectionIntent !== serverId) return false;
        state.directRelaySelectionIntent = null;
        return true;
    }),
}));

/** The slice of `useThisComputerSetupTask`'s options this gate is responsible for wiring. */
type SetupTaskOptionsProbe = Readonly<{
    onSucceeded?: (run: unknown) => void;
    authRequestApproval?: Readonly<{ expectedRelayUrl: string; expectedAccountId: string; serverId?: string }>;
    onUnmanagedCliConsentRequired?: (decision: Readonly<{ cliCommand: string | null }>) => Promise<boolean>;
    onServiceConsentRequired?: (prompt: unknown) => Promise<boolean>;
    onCliChoiceRequired?: (prompt: SetupCliChoicePromptPayload) => Promise<'managed' | 'own' | null>;
}>;

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => spies.machineRpc(params),
}));

/**
 * A daemon configured for `https://old.example.test` — a relay the app is not on — so the pure
 * entry policy derives `setup` and the gate must decide whether the executor may run at all.
 */
const DRIFTED_INSPECTION: DesktopLocalInspection = {
    status: 'resolved',
    facts: {
        acquisition: { command: '/managed/happier', provenance: 'managed', version: null, channel: null },
        server: {
            serverUrl: 'https://old.example.test',
            publicServerUrl: null,
            localServerUrl: null,
            comparableKey: null,
        },
        auth: { credentialState: 'valid', validatedAccountId: 'acct_app', accountId: 'acct_app', accountLabel: null, machineId: 'machine-1' },
        service: { installed: true, running: true, autostart: 'at-login', targetMode: 'default-following' },
        runtimeConvergence: {
            controlReachable: true,
            serviceOwnsRunningDaemon: true,
            machineIdMatches: true,
            cliVersionMatches: true,
        },
        cliUpdate: null,
        cliChoice: { mode: null, otherCli: null },
    },
};

/** The same daemon, after the executor pointed it at the relay the app is on. */
const READY_INSPECTION: DesktopLocalInspection = {
    status: 'resolved',
    facts: {
        acquisition: { command: '/managed/happier', provenance: 'managed', version: null, channel: null },
        server: {
            serverUrl: 'https://relay.example.test',
            publicServerUrl: null,
            localServerUrl: null,
            comparableKey: null,
        },
        auth: { credentialState: 'valid', validatedAccountId: 'acct_app', accountId: 'acct_app', accountLabel: null, machineId: 'machine-1' },
        service: { installed: true, running: true, autostart: 'at-login', targetMode: 'default-following' },
        runtimeConvergence: {
            controlReachable: true,
            serviceOwnsRunningDaemon: true,
            machineIdMatches: true,
            cliVersionMatches: true,
        },
        cliUpdate: null,
        cliChoice: { mode: null, otherCli: null },
    },
};

/**
 * A computer with nothing set up yet: no service, no credentials, no machine. This is the ordinary
 * first-install case, and the only one the gate may converge silently — there is no service of the
 * user's to move.
 */
const UNCONFIGURED_INSPECTION: DesktopLocalInspection = {
    status: 'resolved',
    facts: {
        acquisition: { command: '/managed/happier', provenance: 'managed', version: null, channel: null },
        server: {
            serverUrl: 'https://relay.example.test',
            publicServerUrl: null,
            localServerUrl: null,
            comparableKey: null,
        },
        auth: { credentialState: 'missing', validatedAccountId: null, accountId: null, accountLabel: null, machineId: null },
        service: { installed: false, running: false, autostart: null, targetMode: null },
        runtimeConvergence: {
            controlReachable: false,
            serviceOwnsRunningDaemon: false,
            machineIdMatches: false,
            cliVersionMatches: false,
        },
        cliUpdate: null,
        cliChoice: { mode: null, otherCli: null },
    },
};

/** The app's own on-demand service on the app's relay and account, stopped after the last quit. */
const ON_DEMAND_STOPPED_INSPECTION: DesktopLocalInspection = {
    status: 'resolved',
    facts: {
        ...READY_INSPECTION.facts,
        service: { installed: true, running: false, autostart: 'on-demand', targetMode: 'default-following' },
        runtimeConvergence: {
            controlReachable: false,
            serviceOwnsRunningDaemon: false,
            machineIdMatches: false,
            cliVersionMatches: false,
        },
        cliUpdate: null,
        cliChoice: { mode: null, otherCli: null },
    },
};

vi.mock('./desktopSetupCoordinator', () => ({
    desktopSetupCoordinator: {
        inspect: async (...args: unknown[]) => {
            inspectionStore.beginRead();
            const result = await spies.inspect(...(args as []));
            inspectionStore.publish(result);
            return result;
        },
        subscribe: (listener: () => void) => {
            inspectionStore.listeners.add(listener);
            return () => {
                inspectionStore.listeners.delete(listener);
            };
        },
        readInspectionSnapshot: () => inspectionStore.value,
        readInspectionRefreshing: () => inspectionStore.refreshing,
        readInspectionTaskId: () => null,
        readObservedExpectation: () => state.observed,
        verifyCurrentTarget: (...args: unknown[]) => spies.verifyCurrentTarget(...(args as [])),
        startSetup: (...args: unknown[]) => spies.startSetup(...(args as [])),
        reconcile: (...args: unknown[]) => spies.reconcile(...(args as [])),
    },
}));

/**
 * A stand-in for the coordinator's one readiness proof that keeps the gate's observable inputs
 * honest: it reads through the same `inspect` spy, judges convergence with the REAL policy, and
 * only then asks the machine. The operation's own contract — that it re-reads, that it never asks
 * an unconverged machine anything, and the exact RPC it issues — is proven against real code in
 * `desktopSetupCoordinator.test.ts`.
 */
async function fakeVerifyCurrentTarget(): Promise<unknown> {
    const { desktopLocalRuntimeConverged } = await import('./deriveDesktopLocalSetupSnapshot');
    inspectionStore.beginRead();
    const inspection = await spies.inspect();
    inspectionStore.publish(inspection);
    const expected = {
        relayUrl: state.activeServer.serverUrl,
        localRelayUrl: state.activeServer.activeLocalRelayUrl,
        accountId: state.accountId,
    };
    const machineId = inspection.status === 'resolved' && desktopLocalRuntimeConverged(inspection, expected)
        ? inspection.facts.auth.machineId
        : null;
    if (!machineId) {
        return { status: 'blocked', code: 'runtime_not_converged', inspection };
    }
    try {
        await spies.machineRpc({
            machineId,
            serverId: state.activeServer.serverId,
            method: RPC_METHODS.CAPABILITIES_DESCRIBE,
            payload: {},
        });
    } catch {
        return { status: 'blocked', code: 'machine_unreachable', inspection };
    }
    return { status: 'verified', machineId, inspection };
}

vi.mock('@/components/systemTasks/useThisComputerSetupTask', () => ({
    useThisComputerSetupTask: (options: SetupTaskOptionsProbe) => {
        state.onSetupSucceeded = options.onSucceeded ?? null;
        state.setupTaskOptions = options;
        return {
            activeTaskId: null,
            activeTaskSnapshot: state.setupTaskSnapshot,
            cancel: () => {},
            completedMachineId: null,
            isStarting: false,
            launch: async () => 'task_setup_1',
            runner: null,
            start: async () => 'task_setup_1',
            startError: null,
        };
    },
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ authenticatedThisRun: state.authenticatedThisRun }),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => state.activeServer,
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => (state.accountId ? { serverId: state.activeServer.serverId, accountId: state.accountId } : null),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        subscribe: (listener: () => void) => {
            state.storageListeners.add(listener);
            return () => state.storageListeners.delete(listener);
        },
        getState: () => ({ settings: state.settings }),
    },
    useLocalSetting: (name: string) => (name === 'desktopKeptBackgroundService' ? state.keptBackgroundService : undefined),
}));

vi.mock('./directRelaySelectionIntent', () => ({
    consumeDirectRelaySelectionIntent: (serverId: string) => spies.consumeDirectRelaySelectionIntent(serverId),
    subscribeDirectRelaySelectionIntent: (listener: () => void) => {
        intentListeners.add(listener);
        return () => {
            intentListeners.delete(listener);
        };
    },
    readDirectRelaySelectionIntentGeneration: () => state.intentGeneration,
}));

vi.mock('./desktopBackgroundServiceControl', () => ({
    startBackgroundService: () => spies.startBackgroundService(),
}));

/**
 * What the real direct Relay/Home action does: arm the one-shot fact and count the choice, so a
 * pick of the relay the app is already on is still an answer the gate can act on (B1). The
 * module's own contract is proven in `directRelaySelectionIntent.test.ts`.
 */
function armDirectRelaySelectionIntent(serverId: string): void {
    state.directRelaySelectionIntent = serverId;
    state.intentGeneration += 1;
    for (const listener of Array.from(intentListeners)) listener();
}

vi.mock('./presentRelayReconciliationConsent', () => ({
    presentRelayReconciliationConsent: async () => 'move' as const,
}));

vi.mock('./presentSetupServiceConsent', () => ({
    presentSetupServiceConsent: (prompt: unknown) => spies.presentSetupServiceConsent(prompt),
}));

vi.mock('./presentCliChoice', () => ({
    presentCliChoice: (prompt: unknown) => spies.presentCliChoice(prompt),
}));

vi.mock('./presentUnmanagedCliConsent', () => ({
    presentUnmanagedCliConsent: (decision: Readonly<{ cliCommand: string | null }>) => spies.presentUnmanagedCliConsent(decision),
}));

let observedGate: DesktopLocalSetupGate | null = null;
let authenticate: (() => void) | null = null;
/** Re-reads the mocked active server, the way the real store subscription would. */
let refreshIdentity: (() => void) | null = null;

async function renderGate(enabled = true) {
    const { useDesktopLocalSetupGate } = await import('./useDesktopLocalSetupGate');
    function Harness(props: Readonly<{ initialEnabled: boolean }>) {
        const [gateEnabled, setGateEnabled] = React.useState(props.initialEnabled);
        const [, setTick] = React.useState(0);
        authenticate = () => setGateEnabled(true);
        refreshIdentity = () => setTick((value) => value + 1);
        observedGate = useDesktopLocalSetupGate({ enabled: gateEnabled });
        return React.createElement('GateProbe', {
            presentation: observedGate.snapshot.presentation,
            state: observedGate.snapshot.state,
        });
    }
    return await renderScreen(React.createElement(Harness, { initialEnabled: enabled }));
}

describe('useDesktopLocalSetupGate — what may mutate the local daemon (R8/INV7)', () => {
    beforeEach(() => {
        spies.startSetup.mockClear();
        spies.reconcile.mockClear();
        spies.inspect.mockReset();
        spies.inspect.mockImplementation(async () => UNCONFIGURED_INSPECTION);
        inspectionStore.reset();
        intentListeners.clear();
        spies.startBackgroundService.mockClear();
        spies.startBackgroundService.mockImplementation(async () => {});
        spies.machineRpc.mockReset();
        spies.machineRpc.mockImplementation(async () => ({ ok: true }));
        spies.verifyCurrentTarget.mockReset();
        spies.verifyCurrentTarget.mockImplementation(fakeVerifyCurrentTarget);
        spies.presentSetupServiceConsent.mockReset();
        spies.presentSetupServiceConsent.mockImplementation(async () => true);
        state.activeServer = { serverId: 'custom-2', serverUrl: 'https://relay.example.test', activeLocalRelayUrl: null, generation: 1 };
        state.accountId = 'acct_app';
        state.settings = { serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'custom-2' };
        state.observed = { serverId: 'custom-2', relayUrl: 'https://relay.example.test', localRelayUrl: null, accountId: 'acct_app' };
        state.directRelaySelectionIntent = null;
        state.intentGeneration = 0;
        spies.consumeDirectRelaySelectionIntent.mockClear();
        state.reconcileOutcome = { taskId: 'task_setup_1' };
        state.authenticatedThisRun = false;
        state.storageListeners.clear();
        state.onSetupSucceeded = null;
        state.setupTaskOptions = null;
        state.setupTaskSnapshot = null;
        state.keptBackgroundService = null;
        spies.presentUnmanagedCliConsent.mockClear();
        spies.presentUnmanagedCliConsent.mockImplementation(async () => false);
        observedGate = null;
        authenticate = null;
        refreshIdentity = null;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('converges a computer with nothing installed through the plain executor', async () => {
        // Nothing of the user's is being moved, so there is no UD5 question to ask.
        await renderGate();

        expect(spies.startSetup).toHaveBeenCalledTimes(1);
        expect(spies.reconcile).not.toHaveBeenCalled();
    });

    it('starts setup — whose first step is the one-CLI question — when the read failed on a CLI nobody chose yet (R12)', async () => {
        // A Retry that only re-reads can never get past this; the executor asks the question.
        spies.inspect.mockImplementation(async () => ({
            status: 'failed',
            error: { code: 'cli_choice_required', message: 'The Happier CLI at /usr/local/bin/happier could not answer' },
        }) as DesktopLocalInspection);

        await renderGate();

        expect(spies.startSetup).toHaveBeenCalledTimes(1);
        expect(observedGate?.snapshot).toMatchObject({ state: 'setup', presentation: 'panel', reason: 'cli_choice_required' });
    });

    it('routes a relaunch whose daemon is still on another relay through reconciliation, never a silent repoint (B2)', async () => {
        // The ambient device-scope switch that moved the app here was PERSISTED, so this open has
        // nothing to compare: the app expected this relay when it read the facts, and the daemon
        // is still on the old one. Deciding from the expectation alone therefore called the plain
        // executor and repointed a background service the user never asked to move — INV7's
        // forbidden mutation, deferred by one relaunch. The facts answer it the same way in any
        // run: this service is installed, this installation owns it, and it is somewhere else.
        spies.inspect.mockImplementation(async () => DRIFTED_INSPECTION);

        await renderGate();

        expect(spies.reconcile).toHaveBeenCalledTimes(1);
        expect(spies.startSetup).not.toHaveBeenCalled();
    });

    it('reconciles a relaunch whose daemon is validated for another account (B2)', async () => {
        spies.inspect.mockImplementation(async () => ({
            status: 'resolved',
            facts: {
                ...READY_INSPECTION.facts,
                auth: { ...READY_INSPECTION.facts.auth, validatedAccountId: 'acct_other', accountId: 'acct_other' },
            },
        }) as DesktopLocalInspection);

        await renderGate();

        expect(spies.reconcile).toHaveBeenCalledTimes(1);
        expect(spies.startSetup).not.toHaveBeenCalled();
    });

    it('reconciles a direct Relay/Home selection through the coordinator', async () => {
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 2 };
        state.settings = { serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'custom-3' };
        state.directRelaySelectionIntent = 'custom-3';

        await renderGate();

        expect(spies.reconcile).toHaveBeenCalledTimes(1);
        expect(spies.startSetup).not.toHaveBeenCalled();
    });

    it('performs no daemon mutation for a group selection', async () => {
        // A group may contain several relays and cannot name one daemon target (B2), so the group
        // action records no direct-selection intent.
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 2 };
        state.settings = { serverSelectionActiveTargetKind: 'group', serverSelectionActiveTargetId: 'group-1' };

        await renderGate();

        expect(spies.reconcile).not.toHaveBeenCalled();
        expect(spies.startSetup).not.toHaveBeenCalled();
    });

    it('performs no daemon mutation for a notification-driven server change', async () => {
        // Notification routing, session navigation, voice and machine detail all switch with
        // scope `device`; none of them is the direct Relay/Home action, so no intent exists.
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 2 };
        state.settings = { serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'custom-2' };

        await renderGate();

        expect(spies.reconcile).not.toHaveBeenCalled();
        expect(spies.startSetup).not.toHaveBeenCalled();
    });

    it('shows no setup panel for an ambient relay switch, instead of a panel over nothing (B1)', async () => {
        // A notification moved the app to a relay this computer's daemon is not on. Nothing may be
        // repointed for it (INV7), so nothing runs — and a setup panel with no run, no progress
        // and no action is not an honest way to say so. It is the same answer as declining the
        // move: not ready, not claiming to be, and the drift banner carries it.
        spies.inspect.mockImplementation(async () => DRIFTED_INSPECTION);
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 2 };
        state.settings = { serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'custom-2' };

        await renderGate();

        expect(spies.reconcile).not.toHaveBeenCalled();
        expect(spies.startSetup).not.toHaveBeenCalled();
        expect(observedGate?.snapshot).toMatchObject({ state: 'setup', presentation: 'hidden' });
    });

    it('acts on a direct Relay/Home pick of the relay the app is already on (B1)', async () => {
        // The case an identity comparison cannot see: the ambient switch above already moved the
        // app here and the gate refused to move the daemon. The user now picks this relay on
        // purpose. Nothing about the app changes, so only the choice itself can say the question
        // was answered — otherwise the deliberate pick does nothing at all.
        spies.inspect.mockImplementation(async () => DRIFTED_INSPECTION);
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 2 };
        state.settings = { serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'custom-2' };

        await renderGate();
        expect(observedGate?.snapshot.presentation).toBe('hidden');
        expect(spies.reconcile).not.toHaveBeenCalled();

        await renderer.act(async () => {
            armDirectRelaySelectionIntent('custom-3');
        });

        expect(spies.reconcile).toHaveBeenCalledTimes(1);
        // The refusal was about the ambient switch, not about this relay forever: the answer the
        // user just gave releases it, so the surface is not stuck in a declined state.
        expect(observedGate?.snapshot.presentation).not.toBe('hidden');
    });

    it('performs no daemon mutation for an ambient server change that lands back on the durable preference', async () => {
        // The counterexample the durable preference cannot answer: `custom-3` IS the user's
        // default relay, so after a notification moved the app to `custom-2` and navigation
        // brought it back, the persisted target and the active server agree again — and they
        // agree for a reason the user never asked for. Only the direct action can say otherwise,
        // and it said nothing this run.
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 2 };
        state.settings = { serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'custom-3' };
        state.directRelaySelectionIntent = null;

        await renderGate();

        expect(spies.reconcile).not.toHaveBeenCalled();
        expect(spies.startSetup).not.toHaveBeenCalled();
    });

    it('asks the direct action, and spends its intent instead of re-reading persisted state', async () => {
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 2 };
        state.settings = { serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'custom-3' };
        state.directRelaySelectionIntent = 'custom-3';

        await renderGate();

        expect(spies.consumeDirectRelaySelectionIntent).toHaveBeenCalledWith('custom-3');
        // Spent, not peeked at: nothing may move the daemon a second time on the strength of one
        // choice the user made once.
        expect(state.directRelaySelectionIntent).toBeNull();
        expect(spies.reconcile).toHaveBeenCalledTimes(1);

        // An ambient change now takes the app away and straight back to the same relay.
        state.activeServer = { serverId: 'custom-4', serverUrl: 'https://other.example.test', activeLocalRelayUrl: null, generation: 3 };
        await renderer.act(async () => {
            refreshIdentity?.();
        });
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 4 };
        await renderer.act(async () => {
            refreshIdentity?.();
        });

        expect(spies.reconcile).toHaveBeenCalledTimes(1);
        expect(spies.startSetup).not.toHaveBeenCalled();
    });

    it('routes a same-relay account change through the reconciliation decision', async () => {
        // The relay did not change, but the account did, so the executor is about to re-pair this
        // computer's service to a different account. That is the UD5 question, not ordinary entry
        // convergence, and deciding it by server id alone skipped the consent entirely.
        state.observed = { serverId: 'custom-2', relayUrl: 'https://relay.example.test', localRelayUrl: null, accountId: 'acct_previous' };

        await renderGate();

        expect(spies.reconcile).toHaveBeenCalledTimes(1);
        expect(spies.startSetup).not.toHaveBeenCalled();
    });

    it('reconciles a signed-out direct selection only once authentication has completed', async () => {
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 2 };
        state.settings = { serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'custom-3' };
        state.directRelaySelectionIntent = 'custom-3';

        await renderGate(false);
        expect(spies.reconcile).not.toHaveBeenCalled();

        // The explicit authentication completes and the desktop root enables the gate.
        state.authenticatedThisRun = true;
        await renderer.act(async () => {
            authenticate?.();
        });

        expect(spies.reconcile).toHaveBeenCalledTimes(1);
    });

    /** Completes the executor run the gate started; the gate then re-reads facts and proves them. */
    async function completeSetup(): Promise<void> {
        spies.inspect.mockImplementation(async () => READY_INSPECTION);
        await renderer.act(async () => {
            state.onSetupSucceeded?.({ result: { ok: true, data: { machineId: 'machine-1' } } });
        });
        await renderer.act(async () => {});
    }

    it('reveals only once the machine answers a read-only RPC, and proves it through the existing owner (INV10)', async () => {
        await renderGate();
        expect(spies.startSetup).toHaveBeenCalledTimes(1);

        await completeSetup();

        expect(spies.machineRpc).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'custom-2',
            method: RPC_METHODS.CAPABILITIES_DESCRIBE,
            payload: {},
        });
        expect(observedGate?.verification.status).toBe('verified');
        expect(observedGate?.snapshot.state).toBe('ready');
    });

    it('fails closed on the Home panel when the machine does not answer (INV10)', async () => {
        state.authenticatedThisRun = true;
        spies.machineRpc.mockImplementation(async () => {
            throw new Error('Machine RPC timed out after 30000ms while using active scope for capabilities.describe');
        });

        await renderGate();
        await completeSetup();

        expect(observedGate?.verification).toEqual({ status: 'blocked', code: 'machine_unreachable' });
        expect(observedGate?.snapshot.state).not.toBe('ready');
        expect(observedGate?.snapshot).toMatchObject({ presentation: 'panel', reason: 'machine_unreachable' });
    });

    it('is unaffected by a client clock far ahead of or far behind the relay (A0)', async () => {
        const realNow = Date.now;
        try {
            for (const skewMs of [36 * 60 * 60 * 1000, -36 * 60 * 60 * 1000]) {
                spies.startSetup.mockClear();
                spies.machineRpc.mockClear();
                spies.inspect.mockImplementation(async () => DRIFTED_INSPECTION);
                Date.now = () => realNow() + skewMs;

                await renderGate();
                await completeSetup();

                expect(observedGate?.verification.status).toBe('verified');
                expect(observedGate?.snapshot.state).toBe('ready');
                standardCleanup();
            }
        } finally {
            Date.now = realNow;
        }
    });

    it('reconciles a direct Relay/Home selection made after a setup already verified (R8/SB4)', async () => {
        await renderGate();
        expect(spies.startSetup).toHaveBeenCalledTimes(1);

        await completeSetup();
        expect(observedGate?.verification.status).toBe('verified');

        // The user now picks a different Relay in the footer. Nothing re-inspects (D3); the
        // same facts now describe a relay the app has left, so the snapshot reads `setup`.
        // The previous attempt's proof belongs to that old relay and must not park the gate.
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 2 };
        state.settings = { serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'custom-3' };
        state.directRelaySelectionIntent = 'custom-3';
        await renderer.act(async () => {
            refreshIdentity?.();
        });

        expect(spies.reconcile).toHaveBeenCalledTimes(1);
    });

    it('names a re-read that did not converge instead of working forever (INV8/F2)', async () => {
        // The executor reported success, but the fresh read still describes a daemon that is not
        // this relay's. Nothing may be asked of the machine and nothing may claim ready — and the
        // gate must SETTLE, because a surface left "working" has no Retry and setup cannot
        // restart from it.
        state.authenticatedThisRun = true;
        await renderGate();
        expect(spies.startSetup).toHaveBeenCalledTimes(1);

        await renderer.act(async () => {
            state.onSetupSucceeded?.({ result: { ok: true, data: { machineId: 'machine-1' } } });
        });
        await renderer.act(async () => {});

        expect(spies.verifyCurrentTarget).toHaveBeenCalledWith({ fresh: true });
        expect(spies.machineRpc).not.toHaveBeenCalled();
        expect(observedGate?.verification).toEqual({ status: 'blocked', code: 'runtime_not_converged' });
        expect(observedGate?.snapshot.state).not.toBe('ready');
    });

    it('presents later maintenance on the panel once the first run has settled (R11/F4)', async () => {
        state.authenticatedThisRun = true;
        await renderGate();
        await completeSetup();
        expect(observedGate?.snapshot).toMatchObject({ state: 'ready', presentation: 'hidden' });

        // Hours later, still the same app run: the user picks a different Relay themselves. This
        // is maintenance in an app they are using; the panel carries it, nothing blocks.
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 2 };
        state.settings = { serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'custom-3' };
        state.directRelaySelectionIntent = 'custom-3';
        await renderer.act(async () => {
            refreshIdentity?.();
        });

        expect(observedGate?.snapshot).toMatchObject({ state: 'setup', presentation: 'panel' });
    });

    it('takes the panel away when the user keeps the background service already on this computer (F5)', async () => {
        // "Keep it as is" is a decision, exactly like keeping the service where it is on a relay
        // move. Keeping a panel over it with a Retry that reopens the same question is a trap, so
        // the panel steps aside and setup stays available later.
        state.authenticatedThisRun = true;
        spies.presentSetupServiceConsent.mockImplementation(async () => false);

        await renderGate();
        expect(observedGate?.snapshot.presentation).toBe('panel');

        let approved: boolean | undefined;
        await renderer.act(async () => {
            approved = await state.setupTaskOptions?.onServiceConsentRequired?.({
                taskId: 'task_setup_1',
                takeover: null,
                message: null,
                competingServices: [],
                servicesToRemove: [],
            });
        });

        expect(approved).toBe(false);
        expect(spies.presentSetupServiceConsent).toHaveBeenCalledTimes(1);
        expect(observedGate?.snapshot.presentation).toBe('hidden');
    });

    it('quietly starts its own on-demand service on relaunch, with no panel and no executor (H6)', async () => {
        // The settings toggle promised this computer answers while the app is open. Keeping that
        // promise is a check, not maintenance: the service is already installed for this relay and
        // account, so the app runs the CLI's own start command and proves the result. Running the
        // whole executor under "Setting up this computer" on every single open was the old
        // behaviour, and it was maintenance UI standing in for a lifecycle.
        spies.inspect.mockImplementation(async () => ON_DEMAND_STOPPED_INSPECTION);
        // Held in flight, so what the user sees WHILE the service starts is observable.
        spies.startBackgroundService.mockImplementation(() => new Promise<void>(() => {}));

        await renderGate();

        expect(spies.startBackgroundService).toHaveBeenCalledTimes(1);
        expect(spies.startSetup).not.toHaveBeenCalled();
        expect(spies.reconcile).not.toHaveBeenCalled();
        expect(observedGate?.snapshot).toMatchObject({ state: 'checking', presentation: 'hidden' });
    });

    it('reveals once the quietly started service proves itself (H6)', async () => {
        spies.inspect.mockImplementationOnce(async () => ON_DEMAND_STOPPED_INSPECTION);
        spies.inspect.mockImplementation(async () => READY_INSPECTION);

        await renderGate();
        await renderer.act(async () => {});

        expect(spies.startBackgroundService).toHaveBeenCalledTimes(1);
        expect(observedGate?.snapshot.state).toBe('ready');
        expect(spies.startSetup).not.toHaveBeenCalled();
    });

    it('settles instead of checking forever when the quiet start leaves the service stopped (H6)', async () => {
        spies.inspect.mockImplementation(async () => ON_DEMAND_STOPPED_INSPECTION);

        await renderGate();
        await renderer.act(async () => {});
        await renderer.act(async () => {});

        expect(spies.startBackgroundService).toHaveBeenCalledTimes(1);
        expect(observedGate?.snapshot.state).not.toBe('checking');
        expect(observedGate?.verification).toEqual({ status: 'blocked', code: 'runtime_not_converged' });
    });

    it('converges again when a later read replaces the facts its proof was about (F1)', async () => {
        // A ready app, then any other reader re-reads: Machines › Refresh, the background-service
        // toggle after its install, a settings verify/adopt. The daemon has stopped since. The
        // verdict was about facts that no longer describe this computer, and holding onto it left
        // the trigger gated shut — a setup panel with no run, no progress and
        // no Retry, recoverable only by restarting the app.
        spies.inspect.mockImplementation(async () => READY_INSPECTION);

        await renderGate();
        await renderer.act(async () => {});
        expect(observedGate?.snapshot.state).toBe('ready');
        expect(observedGate?.verification.status).toBe('verified');

        // Running, but no longer the version this app installed: a stopped service would get the
        // quiet start instead (D6), so the executor case needs a daemon that is up and wrong.
        const stopped: DesktopLocalInspection = {
            status: 'resolved',
            facts: {
                ...READY_INSPECTION.facts,
                runtimeConvergence: {
                    controlReachable: true,
                    serviceOwnsRunningDaemon: false,
                    machineIdMatches: true,
                    cliVersionMatches: false,
                },
                cliUpdate: null,
                cliChoice: { mode: null, otherCli: null },
            },
        };
        spies.inspect.mockImplementation(async () => stopped);
        await renderer.act(async () => {
            inspectionStore.beginRead();
        });
        await renderer.act(async () => {
            inspectionStore.publish(stopped);
        });
        await renderer.act(async () => {});

        expect(observedGate?.verification.status).toBe('idle');
        expect(observedGate?.snapshot).toMatchObject({ state: 'setup', reason: 'daemon_not_converged' });
        expect(spies.startSetup).toHaveBeenCalledTimes(1);
        expect(spies.reconcile).not.toHaveBeenCalled();
    });

    it('keeps a settled verdict while the facts it was about stand (F1)', async () => {
        // The reset is keyed to the facts, not to time: a proof that failed must keep its named
        // state and its Retry until something actually re-reads this computer.
        spies.inspect.mockImplementation(async () => READY_INSPECTION);
        spies.machineRpc.mockImplementation(async () => {
            throw new Error('Machine RPC timed out after 30000ms');
        });

        await renderGate();
        await renderer.act(async () => {});

        expect(observedGate?.verification).toEqual({ status: 'blocked', code: 'machine_unreachable' });
        await renderer.act(async () => {});
        expect(observedGate?.verification).toEqual({ status: 'blocked', code: 'machine_unreachable' });
        expect(spies.startSetup).not.toHaveBeenCalled();
    });

    it('reads as checking while a re-read is in flight, without taking the facts from anyone else', async () => {
        // Retry has to be acknowledged on the next frame (`DESIGN.md`), and the gate is the reader
        // for which being mid-check is the thing worth showing. Every other reader — the drift
        // banner, the tray — keeps the facts it already had, which is why the coordinator no longer
        // publishes `pending` over them.
        state.authenticatedThisRun = true;
        await renderGate();
        expect(observedGate?.snapshot.state).toBe('setup');

        // A read that does not answer, so the in-flight window is observable.
        spies.inspect.mockImplementation(() => new Promise(() => {}));
        await renderer.act(async () => {
            observedGate?.retry();
        });

        expect(observedGate?.snapshot.state).toBe('checking');
        expect(observedGate?.inspection.status).toBe('pending');
        expect(inspectionStore.value).toMatchObject({ status: 'resolved' });
    });

    it('asks before claiming a computer whose CLI a person signed in from a terminal as another account (U3)', async () => {
        // No app-owned service at all: the CLI was set up from a terminal as account B. Treating
        // it as a first install replaced B's credentials with no question.
        spies.inspect.mockImplementation(async () => ({
            status: 'resolved',
            facts: {
                ...UNCONFIGURED_INSPECTION.facts,
                auth: { credentialState: 'valid', validatedAccountId: 'acct_terminal', accountId: 'acct_terminal', accountLabel: 'bob', machineId: 'machine-b' },
            },
        }) as DesktopLocalInspection);

        await renderGate();

        expect(spies.reconcile).toHaveBeenCalledTimes(1);
        expect(spies.startSetup).not.toHaveBeenCalled();
    });

    it('does not put a panel or a question in front of a daemon this device chose to keep (D5)', async () => {
        spies.inspect.mockImplementation(async () => DRIFTED_INSPECTION);
        state.keptBackgroundService = { relayKey: 'https://old.example.test', accountId: 'acct_app' };
        state.reconcileOutcome = null;

        await renderGate();

        expect(observedGate?.snapshot).toMatchObject({ state: 'setup', presentation: 'hidden' });
    });

    it('offers a way out of a blocked state that Retry cannot fix (U4)', async () => {
        // The machine was revoked from another device: convergence passes, the relay refuses it,
        // and Retry re-proves the same failure forever. The gate's own decline path takes the
        // panel away; nothing claims ready.
        spies.inspect.mockImplementation(async () => READY_INSPECTION);
        spies.machineRpc.mockImplementation(async () => {
            throw new Error('machine revoked');
        });
        state.authenticatedThisRun = true;

        await renderGate();
        await renderer.act(async () => {});
        expect(observedGate?.snapshot).toMatchObject({ state: 'blocked', presentation: 'panel', reason: 'machine_unreachable' });

        await renderer.act(async () => {
            observedGate?.continueWithoutThisComputer();
        });

        expect(observedGate?.snapshot).toMatchObject({ state: 'blocked', presentation: 'hidden' });
    });

    it('keeps the verify stage while a succeeded run is being proved, never dropping back to checking (U5)', async () => {
        state.authenticatedThisRun = true;
        await renderGate();
        expect(spies.startSetup).toHaveBeenCalledTimes(1);

        // The run succeeded; its proof re-reads, and that read is held in flight.
        state.setupTaskSnapshot = { taskId: 'task_setup_1', status: 'succeeded', events: [], result: { ok: true, data: {} } };
        spies.inspect.mockImplementation(() => new Promise(() => {}));
        await renderer.act(async () => {
            state.onSetupSucceeded?.(state.setupTaskSnapshot);
        });

        expect(observedGate?.verification.status).toBe('verifying');
        expect(observedGate?.inspection.status).toBe('resolved');
        expect(observedGate?.snapshot.state).not.toBe('checking');
    });

    it('takes the panel away when the user keeps the service where it is', async () => {
        state.activeServer = { serverId: 'custom-3', serverUrl: 'https://new.example.test', activeLocalRelayUrl: null, generation: 2 };
        state.settings = { serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'custom-3' };
        state.directRelaySelectionIntent = 'custom-3';
        state.reconcileOutcome = null;

        const screen = await renderGate();

        expect(spies.reconcile).toHaveBeenCalledTimes(1);
        expect(screen.findByType('GateProbe' as never).props.presentation).toBe('hidden');
        expect(screen.findByType('GateProbe' as never).props.state).toBe('setup');
    });
});

describe('useDesktopLocalSetupGate — override-CLI approval is attended, never a dead end (A1/A2)', () => {
    beforeEach(() => {
        spies.inspect.mockReset();
        spies.inspect.mockImplementation(async () => UNCONFIGURED_INSPECTION);
        inspectionStore.reset();
        intentListeners.clear();
        spies.startBackgroundService.mockClear();
        spies.startBackgroundService.mockImplementation(async () => {});
        spies.machineRpc.mockReset();
        spies.machineRpc.mockImplementation(async () => ({ ok: true }));
        spies.verifyCurrentTarget.mockReset();
        spies.verifyCurrentTarget.mockImplementation(fakeVerifyCurrentTarget);
        spies.presentSetupServiceConsent.mockReset();
        spies.presentSetupServiceConsent.mockImplementation(async () => true);
        spies.startSetup.mockClear();
        spies.reconcile.mockClear();
        spies.presentUnmanagedCliConsent.mockClear();
        spies.presentUnmanagedCliConsent.mockImplementation(async () => false);
        state.activeServer = { serverId: 'custom-2', serverUrl: 'https://relay.example.test', activeLocalRelayUrl: null, generation: 1 };
        state.accountId = 'acct_app';
        state.settings = { serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'custom-2' };
        state.observed = { serverId: 'custom-2', relayUrl: 'https://relay.example.test', localRelayUrl: null, accountId: 'acct_app' };
        state.authenticatedThisRun = true;
        state.storageListeners.clear();
        state.setupTaskOptions = null;
        observedGate = null;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('wires the approval target from the identity it selected, even when the ambient inspection failed', async () => {
        // The inspection is an observation, not a precondition for answering the executor's own
        // pairing prompt. Gating the target on it left a failed inspection unable to approve
        // anything, so setup dead-ended on `approval_unavailable`.
        spies.inspect.mockImplementation(async () => ({
            status: 'failed',
            error: { code: 'bridge_unavailable', message: 'no bridge' },
        }) as DesktopLocalInspection);

        await renderGate();

        expect(state.setupTaskOptions?.authRequestApproval).toEqual({
            expectedRelayUrl: 'https://relay.example.test',
            expectedAccountId: 'acct_app',
            serverId: 'custom-2',
        });
    });

    it('takes the panel away when the human declines an override CLI, instead of looping on Retry', async () => {
        await renderGate();
        expect(observedGate?.snapshot.presentation).toBe('panel');

        let declined: boolean | undefined;
        await renderer.act(async () => {
            declined = await state.setupTaskOptions?.onUnmanagedCliConsentRequired?.({ cliCommand: '/repo/apps/cli/bin/happier.mjs' });
        });

        expect(declined).toBe(false);
        expect(spies.presentUnmanagedCliConsent).toHaveBeenCalledTimes(1);
        expect(spies.presentUnmanagedCliConsent.mock.calls[0]?.[0]).toEqual({ cliCommand: '/repo/apps/cli/bin/happier.mjs' });
        // Setup is deferred, not retried: the panel steps aside and the drift banner carries it.
        expect(observedGate?.snapshot.presentation).toBe('hidden');
    });

    it('takes the panel away when the one-CLI question is dismissed, and keeps it for an answer (R12)', async () => {
        const prompt = {
            command: '/usr/local/bin/happier',
            version: '0.2.13',
            origin: 'npm' as const,
            removalCommand: 'npm uninstall -g @happier-dev/cli',
            updateCommand: 'npm install -g @happier-dev/cli@latest',
            belowSetupFloor: false,
            missing: false,
            keepBlockedBy: null,
        };
        spies.presentCliChoice.mockImplementation(async () => 'own');
        await renderGate();
        let answer: string | null | undefined;
        await renderer.act(async () => {
            answer = await state.setupTaskOptions?.onCliChoiceRequired?.(prompt);
        });
        expect(answer).toBe('own');
        expect(spies.presentCliChoice).toHaveBeenCalledWith(prompt);
        expect(observedGate?.snapshot.presentation).toBe('panel');

        spies.presentCliChoice.mockImplementation(async () => null);
        await renderer.act(async () => {
            answer = await state.setupTaskOptions?.onCliChoiceRequired?.(prompt);
        });
        expect(answer).toBeNull();
        expect(observedGate?.snapshot.presentation).toBe('hidden');
    });

    it('keeps the setup panel when the human approves the override CLI', async () => {
        spies.presentUnmanagedCliConsent.mockImplementation(async () => true);

        await renderGate();
        let approved: boolean | undefined;
        await renderer.act(async () => {
            approved = await state.setupTaskOptions?.onUnmanagedCliConsentRequired?.({ cliCommand: '/repo/apps/cli/bin/happier.mjs' });
        });

        expect(approved).toBe(true);
        expect(observedGate?.snapshot.presentation).toBe('panel');
    });
});

describe('DesktopLocalSetupRuntime — the lifecycle runs at the shell, the Home only presents it (R11)', () => {
    beforeEach(() => {
        spies.startSetup.mockClear();
        spies.reconcile.mockClear();
        spies.inspect.mockReset();
        spies.inspect.mockImplementation(async () => UNCONFIGURED_INSPECTION);
        inspectionStore.reset();
        intentListeners.clear();
        spies.verifyCurrentTarget.mockReset();
        spies.verifyCurrentTarget.mockImplementation(fakeVerifyCurrentTarget);
        state.activeServer = { serverId: 'custom-2', serverUrl: 'https://relay.example.test', activeLocalRelayUrl: null, generation: 1 };
        state.accountId = 'acct_app';
        state.observed = { serverId: 'custom-2', relayUrl: 'https://relay.example.test', localRelayUrl: null, accountId: 'acct_app' };
        state.directRelaySelectionIntent = null;
        state.intentGeneration = 0;
        state.reconcileOutcome = { taskId: 'task_setup_1' };
        // The moment right after signing in, before anything about this computer is known.
        state.authenticatedThisRun = true;
        state.setupTaskOptions = null;
        state.setupTaskSnapshot = null;
        state.keptBackgroundService = null;
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderShell(home: boolean) {
        const { DesktopLocalSetupRuntime } = await import('./DesktopLocalSetupRuntime');
        const { DesktopLocalSetupPanel } = await import('./DesktopLocalSetupPanel');
        const element = (withHome: boolean) => React.createElement(
            React.Fragment,
            null,
            React.createElement(DesktopLocalSetupRuntime),
            withHome ? React.createElement(DesktopLocalSetupPanel) : null,
        );
        const screen = await renderScreen(element(home));
        return { screen, showHome: (withHome: boolean) => screen.update(element(withHome)) };
    }

    it('starts setup with no Home on screen, and the Home presents that same run whenever it is shown', async () => {
        // A cold deep link (a session, settings, the inbox) never renders the Home route.
        const { screen, showHome } = await renderShell(false);
        expect(spies.startSetup).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('desktop-setup-panel:panel')).toBeNull();

        await showHome(true);
        expect(screen.findByTestId('desktop-setup-panel:panel')).not.toBeNull();

        // Leaving the Home and coming back neither restarts nor duplicates the lifecycle.
        await showHome(false);
        await showHome(true);
        expect(spies.startSetup).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('desktop-setup-panel:panel')).not.toBeNull();
    });

    it('shows nothing on the Home once the machine is proved ready, and nothing at all without a lifecycle', async () => {
        spies.inspect.mockImplementation(async () => READY_INSPECTION);
        const { screen } = await renderShell(true);
        expect(spies.machineRpc).toHaveBeenCalled();
        const panel = screen.findByTestId('desktop-setup-panel:panel');
        // Proved ready: nothing to present (at most the panel's own departure beat).
        expect(panel == null || panel.props.pointerEvents === 'none').toBe(true);

        standardCleanup();
        const { DesktopLocalSetupPanel } = await import('./DesktopLocalSetupPanel');
        const bare = await renderScreen(React.createElement(DesktopLocalSetupPanel));
        expect(bare.findByTestId('desktop-setup-panel:panel')).toBeNull();
    });
});
