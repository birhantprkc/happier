import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';

import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';

/**
 * R8/INV7 — picking a relay in Settings → Server is a direct user action, exactly like picking one
 * from the connection status control, so it must arm the same one-slot intent the desktop setup
 * gate spends to reconcile this computer's background service.
 *
 * It is recorded here, at the explicit pick, and never inside the screen's shared
 * `switchServerById` helper: that helper is also reached by deep-link auto-add and by group
 * actions, neither of which names one relay a person chose for this device.
 */

installServerSettingsHooksCommonModuleMocks({
    modal: () => createModalModuleMock({
        spies: { alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn(), show: vi.fn() },
    }).module,
});

const recordDirectRelaySelectionIntentMock = vi.hoisted(() => vi.fn());
vi.mock('@/setup/directRelaySelectionIntent', () => ({
    recordDirectRelaySelectionIntent: recordDirectRelaySelectionIntentMock,
    consumeDirectRelaySelectionIntent: vi.fn(() => false),
}));

const promptSignedOutServerSwitchConfirmationMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/components/settings/server/modals/ServerSwitchAuthPrompt', () => ({
    promptSignedOutServerSwitchConfirmation: promptSignedOutServerSwitchConfirmationMock,
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => null,
    retargetPendingTerminalConnectToServerUrl: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderHook<T>(useValue: () => T): Promise<T> {
    let current: T | null = null;

    function Test() {
        current = useValue();
        return null;
    }

    await renderScreen(React.createElement(Test));

    if (!current) throw new Error('Hook did not render');
    return current;
}

const PROFILE = {
    id: 'localhost-18829',
    serverIdentityId: 'srv_identity_a',
    name: 'Local Dev',
    serverUrl: 'https://local.example.test',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: 0,
};

describe('useServerSettingsServerProfileActions (direct relay intent)', () => {
    beforeEach(() => {
        recordDirectRelaySelectionIntentMock.mockReset();
        promptSignedOutServerSwitchConfirmationMock.mockReset();
        promptSignedOutServerSwitchConfirmationMock.mockResolvedValue(true);
    });

    it('records the direct relay selection once, by canonical scope id, before switching', async () => {
        const onSwitchServerById = vi.fn(async () => {});

        const { useServerSettingsServerProfileActions } = await import('./useServerSettingsServerProfileActions');
        const actions = await renderHook(() =>
            useServerSettingsServerProfileActions({
                authStatusByServerId: { srv_identity_a: 'signedIn' },
                onSwitchServerById,
                onAfterSignedOutSwitch: vi.fn(),
                setRevision: vi.fn() as unknown as React.Dispatch<React.SetStateAction<number>>,
            }),
        );

        await actions.onSwitchServer(PROFILE);

        expect(recordDirectRelaySelectionIntentMock.mock.calls).toEqual([['srv_identity_a']]);
        // Armed before the switch, so the gate already sees it when it re-renders on the new identity.
        expect(recordDirectRelaySelectionIntentMock.mock.invocationCallOrder[0])
            .toBeLessThan(onSwitchServerById.mock.invocationCallOrder[0]);
    });

    it('records nothing when the user backs out of a signed-out switch', async () => {
        promptSignedOutServerSwitchConfirmationMock.mockResolvedValue(false);
        const onSwitchServerById = vi.fn(async () => {});

        const { useServerSettingsServerProfileActions } = await import('./useServerSettingsServerProfileActions');
        const actions = await renderHook(() =>
            useServerSettingsServerProfileActions({
                authStatusByServerId: { srv_identity_a: 'signedOut' },
                onSwitchServerById,
                onAfterSignedOutSwitch: vi.fn(),
                setRevision: vi.fn() as unknown as React.Dispatch<React.SetStateAction<number>>,
            }),
        );

        await actions.onSwitchServer(PROFILE);

        expect(onSwitchServerById).not.toHaveBeenCalled();
        expect(recordDirectRelaySelectionIntentMock).not.toHaveBeenCalled();
    });
});
