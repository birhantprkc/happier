import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const mocks = vi.hoisted(() => ({
    runner: {
        start: vi.fn(async (_spec: SystemTaskSpec) => 'task_status_1'),
        cancel: vi.fn(async () => {}),
        respond: vi.fn(async () => {}),
        getSnapshot: vi.fn(() => null),
        subscribe: vi.fn(() => () => {}),
        mode: 'dev' as const,
    },
    activeServer: {
        serverId: 'custom-2',
        serverUrl: 'https://relay.example.test',
        activeLocalRelayUrl: null as string | null,
        generation: 1,
    },
    accountId: 'acct_app' as string | null,
    alwaysMove: false,
    rememberAlwaysMove: vi.fn(() => {}),
    machineRpc: vi.fn(async (_params: unknown) => ({ ok: true }) as unknown),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => mocks.machineRpc(params),
}));

vi.mock('@/components/systemTasks/systemTasksRuntime', () => ({
    getSystemTasksRunner: () => mocks.runner,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => mocks.activeServer,
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => (mocks.accountId ? { serverId: mocks.activeServer.serverId, accountId: mocks.accountId } : null),
}));

vi.mock('./desktopRelayMovePreference', () => ({
    readAlwaysMoveDefaultFollowingService: () => mocks.alwaysMove,
    rememberAlwaysMoveDefaultFollowingService: () => mocks.rememberAlwaysMove(),
}));

const AMBIENT_RESULT = {
    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
    taskId: 'task_status_1',
    ok: true as const,
    data: {
        serviceInstalled: true,
        daemonRunning: true,
        needsAuth: false,
        machineId: 'machine-1',
        acquisition: { command: '/home/user/.happier/cli/current/happier', provenance: 'managed' },
        server: {
            activeServerId: 'custom-2',
            serverUrl: 'https://relay.example.test',
            publicServerUrl: 'https://relay.example.test',
            localServerUrl: null,
            comparableKey: 'https://relay.example.test',
        },
        auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-1',
            needsAuth: false,
            accountId: 'acct_app',
            credentialState: 'valid',
            validatedAccountId: 'acct_app',
        },
        service: { installed: true, running: true, targetMode: 'default-following' },
        daemon: { running: true, startedWithCliVersion: '0.2.13', serviceManaged: true, serviceLabel: 'com.happier.cli.daemon.default' },
        runtimeConvergence: {
            controlReachable: true,
            serviceOwnsRunningDaemon: true,
            machineIdMatches: true,
            cliVersionMatches: true,
        },
    },
};

function resolveWith(result: unknown, options: Readonly<{ taskId?: string }> = {}): void {
    const taskId = options.taskId ?? 'task_status_1';
    mocks.runner.start.mockImplementation(async () => taskId);
    mocks.runner.subscribe.mockImplementation(((_taskId: string, _onEvent: unknown, onResult: unknown) => {
        if (typeof onResult === 'function') {
            (onResult as (value: unknown) => void)(result);
        }
        return () => {};
    }) as never);
}

async function importCoordinator() {
    return await import('./desktopSetupCoordinator');
}

describe('desktopSetupCoordinator', () => {
    beforeEach(() => {
        vi.resetModules();
        mocks.runner.start.mockClear();
        mocks.runner.subscribe.mockReset();
        mocks.accountId = 'acct_app';
        mocks.alwaysMove = false;
        mocks.rememberAlwaysMove.mockClear();
        mocks.machineRpc.mockReset();
        mocks.machineRpc.mockImplementation(async () => ({ ok: true }));
        mocks.activeServer = {
            serverId: 'custom-2',
            serverUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
            generation: 1,
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('runs one ambient inspection per app open and projects the CLI facts', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        const [first, second] = await Promise.all([desktopSetupCoordinator.inspect(), desktopSetupCoordinator.inspect()]);

        expect(mocks.runner.start).toHaveBeenCalledTimes(1);
        expect(first).toEqual(second);
        expect(first).toMatchObject({
            status: 'resolved',
            facts: {
                acquisition: { command: '/home/user/.happier/cli/current/happier', provenance: 'managed' },
                auth: { credentialState: 'valid', validatedAccountId: 'acct_app' },
                runtimeConvergence: { controlReachable: true, machineIdMatches: true },
            },
        });
    });

    it('publishes the one observation to every reader instead of handing each a promise snapshot (F6)', async () => {
        // Two readers, one fact. A reader that snapshots the promise keeps whatever it saw when it
        // mounted, so a fresh read by anyone else — the gate after setup, the toggle after a
        // change, the banner's refresh — reached nobody: the tray kept a title from app open and
        // the settings row beside a repaired daemon still said it was not running.
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        const seen: string[] = [];
        const unsubscribe = desktopSetupCoordinator.subscribe(() => {
            seen.push(desktopSetupCoordinator.readInspectionSnapshot().status);
        });

        try {
            expect(desktopSetupCoordinator.readInspectionSnapshot()).toEqual({ status: 'pending' });
            await desktopSetupCoordinator.inspect();

            expect(desktopSetupCoordinator.readInspectionSnapshot()).toMatchObject({ status: 'resolved' });
            // Both edges are published: the read starting, and the facts it settled on.
            expect(seen).toEqual(['pending', 'resolved']);
            // Referentially stable, so `useSyncExternalStore` readers do not re-render on a read.
            expect(desktopSetupCoordinator.readInspectionSnapshot()).toBe(desktopSetupCoordinator.readInspectionSnapshot());

            await desktopSetupCoordinator.inspect({ fresh: true });
            expect(seen).toEqual(['pending', 'resolved', 'resolved', 'resolved']);
        } finally {
            unsubscribe();
        }

        await desktopSetupCoordinator.inspect({ fresh: true });
        expect(seen).toHaveLength(4);
    });

    it('keeps the last settled facts while a fresh read is in flight (last-known-good)', async () => {
        // `apps/ui/AGENTS.md`: never flash an empty state over hydrated state. Publishing `pending`
        // the moment a re-read starts took the drift banner and the tray title away from surfaces
        // that were already showing true facts about this computer, for as long as the CLI took to
        // answer. The read being in flight is its own fact, reported separately.
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        const settled = await desktopSetupCoordinator.inspect();
        expect(settled).toMatchObject({ status: 'resolved' });

        // A read that never answers, so the in-flight window is observable.
        mocks.runner.subscribe.mockImplementation(((() => () => {}) as never));
        void desktopSetupCoordinator.inspect({ fresh: true });

        expect(desktopSetupCoordinator.readInspectionRefreshing()).toBe(true);
        expect(desktopSetupCoordinator.readInspectionSnapshot()).toBe(settled);
    });

    it('reports pending only until the first read has ever settled', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        expect(desktopSetupCoordinator.readInspectionSnapshot()).toEqual({ status: 'pending' });
        expect(desktopSetupCoordinator.readInspectionRefreshing()).toBe(false);

        await desktopSetupCoordinator.inspect();

        expect(desktopSetupCoordinator.readInspectionRefreshing()).toBe(false);
        expect(desktopSetupCoordinator.readInspectionSnapshot()).toMatchObject({ status: 'resolved' });
    });

    it('starts no second inspection when the footer relay changes; the UI re-compares the same facts', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        await desktopSetupCoordinator.inspect();
        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };
        const afterChange = await desktopSetupCoordinator.inspect();

        expect(mocks.runner.start).toHaveBeenCalledTimes(1);
        expect(afterChange).toMatchObject({ status: 'resolved' });
    });

    it('issues exactly one ambient status command and no service-inventory command on the fast path', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        await desktopSetupCoordinator.inspect();

        const kinds = mocks.runner.start.mock.calls.map(([spec]) => (spec as SystemTaskSpec).kind);
        expect(kinds).toEqual(['daemon.service.status.v1']);
        const params = (mocks.runner.start.mock.calls[0]?.[0] as SystemTaskSpec).params as Record<string, unknown>;
        expect(JSON.stringify(params)).not.toContain('--no-persist');
        expect(params).not.toHaveProperty('relayUrl');
        expect(params).not.toHaveProperty('serverUrl');
    });

    it('reports a failed inspection instead of guessing, and retries it when setup asks again', async () => {
        resolveWith({
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            taskId: 'task_status_1',
            ok: false,
            error: { code: 'cli_spawn_failed', message: 'boom' },
        });
        const { desktopSetupCoordinator } = await importCoordinator();

        await expect(desktopSetupCoordinator.inspect()).resolves.toEqual({
            status: 'failed',
            error: { code: 'cli_spawn_failed', message: 'boom' },
        });

        resolveWith(AMBIENT_RESULT);
        await expect(desktopSetupCoordinator.inspect()).resolves.toMatchObject({ status: 'resolved' });
        expect(mocks.runner.start).toHaveBeenCalledTimes(2);
    });

    it('re-reads facts only when the post-setup proof asks for a fresh inspection', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        await desktopSetupCoordinator.inspect();
        await desktopSetupCoordinator.inspect();
        expect(mocks.runner.start).toHaveBeenCalledTimes(1);

        await desktopSetupCoordinator.inspect({ fresh: true });
        await desktopSetupCoordinator.inspect();
        expect(mocks.runner.start).toHaveBeenCalledTimes(2);
    });

    it('awaits the in-flight inspection, then starts the executor with the app relay, account and ring', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        const inspecting = desktopSetupCoordinator.inspect();
        const outcome = await desktopSetupCoordinator.startSetup({ start: startExecutor });
        await inspecting;

        expect(mocks.runner.start).toHaveBeenCalledTimes(1);
        expect(outcome).toEqual({ taskId: 'task_setup_1' });
        expect(startExecutor).toHaveBeenCalledTimes(1);
        const spec = startExecutor.mock.calls[0]?.[0] as SystemTaskSpec;
        expect(spec.kind).toBe('setup.thisComputer.v1');
        expect(spec.params).toMatchObject({
            activeRelayUrl: 'https://relay.example.test',
            expectedAccountId: 'acct_app',
            channel: 'stable',
            surface: 'desktop.ui',
        });
    });

    it('reconciles a direct relay change silently when the app\'s own service is where it put it', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();

        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };
        const confirm = vi.fn(async () => 'move' as const);
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        const outcome = await desktopSetupCoordinator.reconcile({ start: startExecutor, confirm });

        expect(confirm).not.toHaveBeenCalled();
        expect(outcome).toEqual({ taskId: 'task_setup_1' });
        expect((startExecutor.mock.calls[0]?.[0] as SystemTaskSpec).params).toMatchObject({
            activeRelayUrl: 'https://other.example.test',
        });
    });

    it('asks before moving a service whose target mode the CLI did not prove (UD5)', async () => {
        // `service.targetMode` is absent from an older CLI's status. UNKNOWN is not evidence that
        // this service follows the app's selected default relay, so the projection keeps it `null`
        // and the decision asks instead of moving it silently.
        const { service: _service, ...restData } = AMBIENT_RESULT.data;
        resolveWith({ ...AMBIENT_RESULT, data: { ...restData, service: { installed: true, running: true } } });
        const { desktopSetupCoordinator } = await importCoordinator();
        const inspection = await desktopSetupCoordinator.inspect();
        expect(inspection).toMatchObject({ status: 'resolved', facts: { service: { targetMode: null } } });

        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };
        mocks.alwaysMove = true;
        const confirm = vi.fn(async () => 'keep' as const);
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        await expect(desktopSetupCoordinator.reconcile({ start: startExecutor, confirm })).resolves.toBeNull();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(startExecutor).not.toHaveBeenCalled();
    });

    it('asks before moving a service that is not where the app put it, and does nothing when kept', async () => {
        resolveWith({
            ...AMBIENT_RESULT,
            data: {
                ...AMBIENT_RESULT.data,
                server: { ...AMBIENT_RESULT.data.server, serverUrl: 'https://hand-configured.example.test', publicServerUrl: null, comparableKey: 'https://hand-configured.example.test' },
            },
        });
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();

        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };
        const confirm = vi.fn(async () => 'keep' as const);
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        await expect(desktopSetupCoordinator.reconcile({ start: startExecutor, confirm })).resolves.toBeNull();
        expect(confirm).toHaveBeenCalledWith({ relayUrl: 'https://other.example.test' });
        expect(startExecutor).not.toHaveBeenCalled();
    });

    it('remembers the device preference only when the user chose "always"', async () => {
        resolveWith({
            ...AMBIENT_RESULT,
            data: {
                ...AMBIENT_RESULT.data,
                server: { ...AMBIENT_RESULT.data.server, serverUrl: 'https://hand-configured.example.test', publicServerUrl: null, comparableKey: 'https://hand-configured.example.test' },
            },
        });
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();

        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');
        await desktopSetupCoordinator.reconcile({ start: startExecutor, confirm: async () => 'move' });
        expect(mocks.rememberAlwaysMove).not.toHaveBeenCalled();

        await desktopSetupCoordinator.reconcile({ start: startExecutor, confirm: async () => 'always' });
        expect(mocks.rememberAlwaysMove).toHaveBeenCalledTimes(1);
    });

    it('does not double-start: reconcile drives the same executor once per call', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        await desktopSetupCoordinator.reconcile({ start: startExecutor, confirm: async () => 'move' });

        expect(startExecutor).toHaveBeenCalledTimes(1);
        const kinds = startExecutor.mock.calls.map(([spec]) => (spec as SystemTaskSpec).kind);
        expect(kinds).toEqual(['setup.thisComputer.v1']);
    });

    it('does not report acquisition complete when the inspection failed', async () => {
        resolveWith({
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            taskId: 'task_status_1',
            ok: false,
            error: { code: 'cli_spawn_failed', message: 'boom' },
        });
        const { desktopSetupCoordinator } = await importCoordinator();

        const outcome = await desktopSetupCoordinator.startSetup({ start: async () => 'task_setup_1' });

        expect(outcome).toEqual({ taskId: 'task_setup_1' });
    });

    it('records the identity the app had when the ambient read was requested, not when it settled (INV7)', async () => {
        // The ambient read acquires and installs the managed CLI, so it is open for seconds. A
        // navigation-, notification-, deep-link-, voice- or focus-driven switch can land inside
        // that window. Capturing the app identity only once the read settles would make such a
        // switch invisible to the relay-change discriminator: it would read as ordinary entry
        // convergence and mutate the daemon onto a relay the user never chose (INV7), and a
        // genuine direct selection landing there would skip UD5 consent.
        const settlers: ((result: unknown) => void)[] = [];
        mocks.runner.start.mockImplementation(async () => 'task_status_1');
        mocks.runner.subscribe.mockImplementation(((_taskId: string, _onEvent: unknown, onResult: unknown) => {
            settlers.push(onResult as (result: unknown) => void);
            return () => {};
        }) as never);
        const { desktopSetupCoordinator } = await importCoordinator();

        const inspecting = desktopSetupCoordinator.inspect();
        // Let the coordinator reach its subscription; the read is now genuinely in flight.
        await new Promise((resolve) => setTimeout(resolve, 0));
        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };
        settlers[0]?.(AMBIENT_RESULT);
        await inspecting;

        expect(desktopSetupCoordinator.readObservedExpectation()).toMatchObject({
            serverId: 'custom-2',
            relayUrl: 'https://relay.example.test',
        });
    });

    it('adopts the first signed-in reader\'s identity when the read was warmed before sign-in (R5/INV4)', async () => {
        // The warm-up starts at app open, before the user has chosen where to sign in. An
        // observation made then expected NOTHING of this computer, so it cannot discriminate a
        // relay change: the user picking a relay in the welcome footer and then signing in would
        // otherwise read as "the app moved" and suppress first-run setup entirely (R2).
        resolveWith(AMBIENT_RESULT);
        mocks.accountId = null;
        const { desktopSetupCoordinator } = await importCoordinator();

        await desktopSetupCoordinator.inspect();
        expect(desktopSetupCoordinator.readObservedExpectation()).toMatchObject({ serverId: 'custom-2', accountId: null });

        // The welcome footer relay change, then sign-in.
        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };
        mocks.accountId = 'acct_app';
        const reused = await desktopSetupCoordinator.inspect();

        expect(mocks.runner.start).toHaveBeenCalledTimes(1);
        expect(reused).toMatchObject({ status: 'resolved' });
        expect(desktopSetupCoordinator.readObservedExpectation()).toMatchObject({
            serverId: 'custom-3',
            relayUrl: 'https://other.example.test',
            accountId: 'acct_app',
        });
    });

    it('keeps a signed-in observation even when the app moves afterwards (INV7)', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        await desktopSetupCoordinator.inspect();
        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };
        await desktopSetupCoordinator.inspect();

        expect(desktopSetupCoordinator.readObservedExpectation()).toMatchObject({
            serverId: 'custom-2',
            relayUrl: 'https://relay.example.test',
        });
    });

    it('proves readiness through the running daemon and one read-only machine RPC, never a task result (INV8/INV10)', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        await expect(desktopSetupCoordinator.verifyCurrentTarget()).resolves.toMatchObject({
            status: 'verified',
            machineId: 'machine-1',
        });
        expect(mocks.machineRpc).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'custom-2',
            method: RPC_METHODS.CAPABILITIES_DESCRIBE,
            payload: {},
        });
    });

    it('names a resolved-but-non-convergent runtime instead of hanging, and asks the machine nothing (INV8)', async () => {
        // The service command can succeed while the running daemon still carries the wrong
        // identity. There is nothing to ask the relay about, so the verdict settles here.
        resolveWith({
            ...AMBIENT_RESULT,
            data: {
                ...AMBIENT_RESULT.data,
                runtimeConvergence: { ...AMBIENT_RESULT.data.runtimeConvergence, machineIdMatches: false },
            },
        });
        const { desktopSetupCoordinator } = await importCoordinator();

        await expect(desktopSetupCoordinator.verifyCurrentTarget()).resolves.toMatchObject({
            status: 'blocked',
            code: 'runtime_not_converged',
        });
        expect(mocks.machineRpc).not.toHaveBeenCalled();
    });

    it('names an unreachable machine when the runtime converged but the relay cannot reach it (INV10)', async () => {
        resolveWith(AMBIENT_RESULT);
        mocks.machineRpc.mockImplementation(async () => {
            throw new Error('Machine RPC timed out after 30000ms');
        });
        const { desktopSetupCoordinator } = await importCoordinator();

        await expect(desktopSetupCoordinator.verifyCurrentTarget()).resolves.toMatchObject({
            status: 'blocked',
            code: 'machine_unreachable',
        });
    });

    it('never claims ready for a converged daemon that belongs to a relay the app is not on', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };

        await expect(desktopSetupCoordinator.verifyCurrentTarget()).resolves.toMatchObject({
            status: 'blocked',
            code: 'runtime_not_converged',
        });
        expect(mocks.machineRpc).not.toHaveBeenCalled();
    });

    it('re-reads the runtime only when the caller asks for a fresh proof', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        await desktopSetupCoordinator.inspect();
        await desktopSetupCoordinator.verifyCurrentTarget();
        expect(mocks.runner.start).toHaveBeenCalledTimes(1);

        await desktopSetupCoordinator.verifyCurrentTarget({ fresh: true });
        expect(mocks.runner.start).toHaveBeenCalledTimes(2);
    });

    it('refuses to start setup without an explicit relay and account rather than falling back to ambient state (R3/B6)', async () => {
        resolveWith(AMBIENT_RESULT);
        mocks.accountId = null;
        const { desktopSetupCoordinator } = await importCoordinator();
        const startExecutor = vi.fn(async () => 'task_setup_1');

        await expect(desktopSetupCoordinator.startSetup({ start: startExecutor })).rejects.toThrow(/account/i);
        expect(startExecutor).not.toHaveBeenCalled();
    });
});
