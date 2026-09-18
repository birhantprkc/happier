import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const activeServerSnapshot = vi.hoisted(() => ({
    serverId: 'relay-example',
    serverUrl: 'https://relay.example.test',
    activeLocalRelayUrl: null as string | null,
    generation: 1,
}));

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    accent: {
                        blue: 'blue',
                        orange: 'orange',
                        indigo: 'indigo',
                    },
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title, footer }: { children?: React.ReactNode; title?: React.ReactNode; footer?: React.ReactNode }) =>
        React.createElement('Group', { title, footer }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

vi.mock('@/sync/domains/server/serverProfiles', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/server/serverProfiles')>('@/sync/domains/server/serverProfiles');
    return {
        ...actual,
        getActiveServerSnapshot: () => activeServerSnapshot,
    };
});

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => ({ serverId: activeServerSnapshot.serverId, accountId: 'acct_app' }),
}));

// `desktopSetupCoordinator` is a module singleton that reads the app-wide runner. Pointing it at
// each test's bridge keeps the ambient inspection on the same fake boundary as the section.
const runnerRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/components/systemTasks/systemTasksRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/systemTasks/systemTasksRuntime')>();
    return {
        ...actual,
        getSystemTasksRunner: () => runnerRef.current ?? actual.getSystemTasksRunner(),
    };
});

/** What `daemon.service.status.v1` reports on a healthy managed install (Lane B's projection). */
const HEALTHY_AMBIENT_STATUS_DATA = {
    serviceInstalled: true,
    daemonRunning: true,
    needsAuth: false,
    machineId: 'machine-local-1',
    acquisition: { command: '/managed/happier', provenance: 'managed' },
    server: {
        activeServerId: 'relay-example',
        serverUrl: 'https://relay.example.test',
        publicServerUrl: 'https://relay.example.test',
        localServerUrl: null,
        comparableKey: 'relay.example.test',
    },
    auth: {
        authenticated: true,
        machineRegistered: true,
        machineId: 'machine-local-1',
        needsAuth: false,
        accountId: 'acct_app',
        credentialState: 'valid',
        validatedAccountId: 'acct_app',
    },
    service: { installed: true, running: true },
    daemon: { running: true, startedWithCliVersion: '0.2.13', serviceManaged: true, serviceLabel: 'dev.happier.daemon' },
    runtimeConvergence: {
        controlReachable: true,
        serviceOwnsRunningDaemon: true,
        machineIdMatches: true,
        cliVersionMatches: true,
    },
} as const;

/**
 * The one ambient read every desktop surface shares (F6). Each case sets what the CLI answers
 * before mounting, because the section no longer runs a status command of its own.
 */
const ambient = { data: HEALTHY_AMBIENT_STATUS_DATA as unknown, fails: false };

/**
 * Lets the one shared inspection settle: a macrotask for the fake bridge's reply, then the effect
 * cycles that publish it and re-render every reader. Both halves matter — asserting after a single
 * turn made the row's facts a race under parallel test load.
 */
async function settleAmbientInspection(): Promise<void> {
    await renderer.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flushHookEffects({ cycles: 3, turns: 3 });
}

describe('LocalDaemonControlSection', () => {
    beforeEach(async () => {
        // `desktopSetupCoordinator` memoises one inspection per app open; a fresh module registry
        // gives each case its own instead of the first case's answer.
        vi.resetModules();
        ambient.data = HEALTHY_AMBIENT_STATUS_DATA;
        ambient.fails = false;
        // `desktopSetupCoordinator` is a module singleton holding one ambient-inspection promise.
        // Point it at a bridge that always answers, so the shared inspection settles in every case
        // instead of leaking a pending promise into the next one.
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        runnerRef.current = createSystemTaskRunner({
            bridge: {
                async start() {
                    if (ambient.fails) {
                        throw new Error('daemon status request failed');
                    }
                    return 'ambient:daemon.service.status.v1';
                },
                async subscribe(taskId, listenerSet) {
                    queueMicrotask(() => {
                        listenerSet.onResult({ protocolVersion: 1, taskId, ok: true, data: ambient.data });
                    });
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });
        activeServerSnapshot.serverId = 'relay-example';
        activeServerSnapshot.serverUrl = 'https://relay.example.test';
        activeServerSnapshot.activeLocalRelayUrl = null;
        activeServerSnapshot.generation = 1;
    });

    it('reads the one shared inspection and starts the local daemon service from the control row', async () => {
        // The row starts no status command of its own: it renders the ambient inspection every
        // other desktop surface renders, so the gate, the drift banner and this row cannot
        // describe the same computer differently (F6).
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            serviceInstalled: true,
            daemonRunning: false,
            service: { installed: true, running: false },
            runtimeConvergence: { ...HEALTHY_AMBIENT_STATUS_DATA.runtimeConvergence, controlReachable: false },
        };

        let nextTaskId = 1;
        const starts: unknown[] = [];
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
                    return `task_${nextTaskId++}:${parsed.kind}`;
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await settleAmbientInspection();

        expect(starts).toEqual([]);
        expect(screen.findByTestId('settings.localDaemonControl.status')?.props.subtitle).toBe('server.relayDrift.bannerNotRunningDescription');
        expect(screen.findByTestId('settings.localDaemonControl.machineId')?.props.subtitle).toBe('machine-local-1');

        await screen.pressByTestIdAsync('settings.localDaemonControl.start');

        expect(starts.some((entry) => (entry as { kind?: unknown }).kind === 'daemon.service.start.v1')).toBe(true);
    });

    it('re-reads the shared inspection when Refresh is pressed', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task_unused';
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await settleAmbientInspection();
        expect(screen.findByTestId('settings.localDaemonControl.status')?.props.subtitle).toBe('machine.daemonStatus.likelyAlive');

        // The service stopped while the settings screen was open.
        ambient.data = {
            ...HEALTHY_AMBIENT_STATUS_DATA,
            serviceInstalled: true,
            daemonRunning: false,
            service: { installed: true, running: false },
            runtimeConvergence: { ...HEALTHY_AMBIENT_STATUS_DATA.runtimeConvergence, controlReachable: false },
        };
        await screen.pressByTestIdAsync('settings.localDaemonControl.refresh');
        await settleAmbientInspection();

        expect(screen.findByTestId('settings.localDaemonControl.status')?.props.subtitle).toBe('server.relayDrift.bannerNotRunningDescription');
    });

    it('repairs through the one setup executor, never the deleted relay.connectBackgroundService kind', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const starts: unknown[] = [];

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
                    return `task_${nextTaskId++}:${parsed.kind}`;
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await renderer.act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        await screen.pressByTestIdAsync('settings.localDaemonControl.repair');
        await renderer.act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(starts.some((entry) => (entry as { kind?: unknown }).kind === 'relay.connectBackgroundService.v1')).toBe(false);
        expect(starts).toContainEqual(expect.objectContaining({
            kind: 'setup.thisComputer.v1',
            params: expect.objectContaining({
                activeRelayUrl: 'https://relay.example.test',
                activeWebappUrl: 'https://relay.example.test',
                activeLocalRelayUrl: null,
                expectedAccountId: 'acct_app',
                surface: 'desktop.ui',
            }),
        }));
    });

    it('surfaces a recoverable status error without disabling daemon repair', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        ambient.fails = true;

        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task_unused';
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await settleAmbientInspection();

        expect(screen.findByTestId('settings.localDaemonControl.status')?.props.subtitle).toBe('machine.daemonStatus.unknown');
        expect(screen.findByProps({ subtitle: 'daemon status request failed' })).toBeTruthy();
        expect(screen.findByTestId('settings.localDaemonControl.repair')?.props.disabled).toBe(false);
    });
});
