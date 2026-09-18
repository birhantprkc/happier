import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light' }));
vi.mock('@/assets/images/logotype-dark.png', () => ({ default: 'logotype-dark' }));

const expoRouterMock = createExpoRouterMock({
    router: { push: vi.fn(), replace: vi.fn() },
});
vi.mock('expo-router', () => expoRouterMock.module);

const tauriDesktopState = vi.hoisted(() => ({ value: true }));
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

let isAuthenticated = true;
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated,
    }),
}));

vi.mock('@/components/navigation/shell/MainView', () => ({
    MainView: () => null,
}));

vi.mock('@/components/navigation/shell/HomeHeader', () => ({
    HomeHeaderNotAuth: () => null,
}));

const pendingTerminalConnectState = vi.hoisted(() => ({
    value: null as null | { publicKeyB64Url: string; serverUrl: string },
}));
vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => pendingTerminalConnectState.value,
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: vi.fn(async () => ({ status: 'ready', features: { capabilities: { auth: { methods: [] } } } })),
}));

type TestPendingSetupIntent = Readonly<{ branch: string; phase: string; relayUrl: string | null; machineId?: string | null }>;
const pendingSetupIntentState = vi.hoisted(() => ({
    value: {
        branch: 'thisComputer',
        phase: 'awaiting_auth',
        relayUrl: 'https://relay.example.test',
    } as TestPendingSetupIntent | null,
}));
const clearPendingSetupIntentSpy = vi.hoisted(() => vi.fn());
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    getPendingSetupIntent: () => pendingSetupIntentState.value,
    clearPendingSetupIntent: () => clearPendingSetupIntentSpy(),
}));

describe('/ (welcome) setup continuation', () => {
    beforeEach(() => {
        isAuthenticated = true;
        tauriDesktopState.value = true;
        pendingTerminalConnectState.value = null;
        pendingSetupIntentState.value = {
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        };
        clearPendingSetupIntentSpy.mockReset();
        expoRouterMock.spies.replace.mockReset();
        expoRouterMock.spies.push.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('keeps a this-computer continuation at the root gate instead of routing to /setup, and consumes it (R9/INV1)', async () => {
        const Screen = (await import('@/app/(app)/index')).default;
        await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
        expect(clearPendingSetupIntentSpy).toHaveBeenCalledTimes(1);
    });

    it('still routes a remote-machine continuation to /setup, which owns provider follow-up', async () => {
        pendingSetupIntentState.value = {
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
        };

        const Screen = (await import('@/app/(app)/index')).default;
        await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/setup');
        expect(clearPendingSetupIntentSpy).not.toHaveBeenCalled();
    });

    it('does not redirect browser web users back to /setup when a setup auth continuation is pending', async () => {
        tauriDesktopState.value = false;
        pendingSetupIntentState.value = {
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
        };

        const Screen = (await import('@/app/(app)/index')).default;
        await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
        expect(clearPendingSetupIntentSpy).not.toHaveBeenCalled();
    });

    it('does not redirect to /setup while a terminal connect approval is pending', async () => {
        pendingTerminalConnectState.value = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://relay.example.test',
        };
        pendingSetupIntentState.value = {
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
        };

        const Screen = (await import('@/app/(app)/index')).default;
        await renderScreen(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith('/setup');
        expect(clearPendingSetupIntentSpy).not.toHaveBeenCalled();
    });
});
