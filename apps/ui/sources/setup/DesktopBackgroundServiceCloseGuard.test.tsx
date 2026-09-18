import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    autostart: 'on-demand' as 'at-login' | 'on-demand' | null,
    machineId: 'machine-local-1' as string | null,
    /** The account the relay validated the daemon's credentials for (H4). */
    daemonAccountId: 'acct_app' as string | null,
    /** The account the app itself is signed in to on its active relay (H4). */
    appAccountId: 'acct_app' as string | null,
    inspectionFailed: false,
    /** F9 — nothing has asked for an inspection yet, so there is nothing to peek at. */
    noInspection: false,
    finishThrows: false,
    listenThrows: false,
    sessions: {} as Record<string, unknown>,
    consentAnswer: 'keep' as 'keep' | 'stop',
    consentThrows: false,
    stopThrows: false,
}));

const stopBackgroundServiceMock = vi.hoisted(() => vi.fn(async () => {}));
const presentConsentMock = vi.hoisted(() => vi.fn(async () => {
    if (state.consentThrows) {
        throw new Error('no surface to ask on');
    }
    return state.consentAnswer;
}));
const invokeTauriMock = vi.hoisted(() => vi.fn(async (command: string) => {
    if (command === 'desktop_finish_shutdown' && state.finishThrows) {
        throw new Error('the webview is gone');
    }
    return undefined;
}));
const listeners = vi.hoisted(() => [] as Array<() => void>);
const disposeMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/platform/tauri', () => ({
    invokeTauri: invokeTauriMock,
    listenTauriEvent: async (_event: string, handler: () => void) => {
        if (state.listenThrows) {
            throw new Error('no event system here');
        }
        listeners.push(handler);
        return disposeMock;
    },
}));

vi.mock('./desktopBackgroundServiceControl', () => ({
    stopBackgroundService: async () => {
        if (state.stopThrows) {
            throw new Error('the stop command failed');
        }
        return stopBackgroundServiceMock();
    },
}));

vi.mock('./presentBackgroundServiceCloseConsent', () => ({
    presentBackgroundServiceCloseConsent: presentConsentMock,
}));

const inspectMock = vi.hoisted(() => vi.fn(async () => undefined));
/** A read that never answers, to prove the exit is not held on one (F7). */
const peekMock = vi.hoisted(() => vi.fn(() => new Promise<never>(() => {})));

vi.mock('./desktopSetupCoordinator', () => ({
    desktopSetupCoordinator: {
        // Present so a call would be observable; the guard must never make one (F9) and must never
        // wait on one (F7).
        inspect: inspectMock,
        peekInspection: peekMock,
        readInspectionSnapshot: () => (state.noInspection
            ? { status: 'pending' }
            : state.inspectionFailed
                ? { status: 'failed', error: { code: 'nope', message: 'nope' } }
                : {
                    status: 'resolved',
                    facts: {
                        service: { installed: true, running: true, autostart: state.autostart },
                        auth: { machineId: state.machineId, validatedAccountId: state.daemonAccountId },
                    },
                }),
    },
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => (state.appAccountId ? { serverId: 'relay-example', accountId: state.appAccountId } : null),
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => ({ getState: () => ({ sessions: state.sessions }) }),
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readDisplayMachineIdForSession: (input: { metadata?: { machineId?: string } | null }) =>
        input.metadata?.machineId ?? '',
}));

import { DesktopBackgroundServiceCloseGuard } from './DesktopBackgroundServiceCloseGuard';

function activeSessionOn(machineId: string, id: string) {
    return { id, active: true, metadata: { machineId } };
}

async function mountAndQuit(): Promise<void> {
    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
        tree = renderer.create(<DesktopBackgroundServiceCloseGuard enabled />);
    });
    await act(async () => {
        listeners.forEach((listener) => listener());
        await Promise.resolve();
    });
    // Let the handler's awaited chain settle before anything is asserted.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { tree?.unmount(); });
}

describe('DesktopBackgroundServiceCloseGuard', () => {
    beforeEach(() => {
        listeners.length = 0;
        state.autostart = 'on-demand';
        state.machineId = 'machine-local-1';
        state.daemonAccountId = 'acct_app';
        state.appAccountId = 'acct_app';
        state.inspectionFailed = false;
        state.noInspection = false;
        state.finishThrows = false;
        state.listenThrows = false;
        inspectMock.mockClear();
        peekMock.mockClear();
        state.sessions = {};
        state.consentAnswer = 'keep';
        state.consentThrows = false;
        state.stopThrows = false;
        stopBackgroundServiceMock.mockClear();
        presentConsentMock.mockClear();
        invokeTauriMock.mockClear();
    });

    it('stops the background service on quit when nothing is running here', async () => {
        await mountAndQuit();

        expect(presentConsentMock).not.toHaveBeenCalled();
        expect(stopBackgroundServiceMock).toHaveBeenCalledTimes(1);
        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_finish_shutdown');
    });

    it('asks before ending agent sessions running on this computer, and honours "stop anyway"', async () => {
        state.sessions = { a: activeSessionOn('machine-local-1', 'a') };
        state.consentAnswer = 'stop';

        await mountAndQuit();

        expect(presentConsentMock).toHaveBeenCalledTimes(1);
        expect(stopBackgroundServiceMock).toHaveBeenCalledTimes(1);
    });

    it('honours "leave it running" and still lets the app quit', async () => {
        state.sessions = { a: activeSessionOn('machine-local-1', 'a') };
        state.consentAnswer = 'keep';

        await mountAndQuit();

        expect(stopBackgroundServiceMock).not.toHaveBeenCalled();
        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_finish_shutdown');
    });

    it('does not count sessions running on other computers', async () => {
        state.sessions = { a: activeSessionOn('machine-somewhere-else', 'a') };

        await mountAndQuit();

        expect(presentConsentMock).not.toHaveBeenCalled();
        expect(stopBackgroundServiceMock).toHaveBeenCalledTimes(1);
    });

    it('leaves the service running when the question cannot be put to anyone', async () => {
        state.sessions = { a: activeSessionOn('machine-local-1', 'a') };
        state.consentThrows = true;

        await mountAndQuit();

        expect(stopBackgroundServiceMock).not.toHaveBeenCalled();
        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_finish_shutdown');
    });

    it('never stops a service that starts at login', async () => {
        state.autostart = 'at-login';

        await mountAndQuit();

        expect(presentConsentMock).not.toHaveBeenCalled();
        expect(stopBackgroundServiceMock).not.toHaveBeenCalled();
    });

    it('brings the window back before asking, so the question is not put to a hidden webview (H5)', async () => {
        // Quit from the tray never shows the window. Asking there held the exit on a modal nobody
        // could see: Quit appeared to do nothing, and a second Quit left the service running.
        state.sessions = { a: activeSessionOn('machine-local-1', 'a') };
        state.consentAnswer = 'stop';

        await mountAndQuit();

        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_show_main_window');
        const shownAt = invokeTauriMock.mock.invocationCallOrder[
            invokeTauriMock.mock.calls.findIndex(([command]) => command === 'desktop_show_main_window')
        ];
        expect(shownAt).toBeLessThan(presentConsentMock.mock.invocationCallOrder[0] ?? 0);
    });

    it('never shows the window when nothing is being asked (H5)', async () => {
        await mountAndQuit();

        expect(invokeTauriMock).not.toHaveBeenCalledWith('desktop_show_main_window');
        expect(stopBackgroundServiceMock).toHaveBeenCalledTimes(1);
    });

    it('asks when the daemon is paired to another account than the app (H4)', async () => {
        // The app's session store only holds its own relay and account, so it cannot see what this
        // daemon is running. Stopping it would end agent sessions nobody was asked about.
        state.daemonAccountId = 'acct_other';

        await mountAndQuit();

        expect(presentConsentMock).toHaveBeenCalledTimes(1);
        expect(stopBackgroundServiceMock).not.toHaveBeenCalled();
    });

    it('asks when the app has no account of its own to compare (H4)', async () => {
        state.appAccountId = null;

        await mountAndQuit();

        expect(presentConsentMock).toHaveBeenCalledTimes(1);
    });

    it('neither starts nor waits on a local inspection while the exit is held (F9/F7)', async () => {
        // A brand new read here would begin a managed-CLI acquisition, bounded only by the user
        // pressing Quit again — and awaiting the warm-up's in-flight read holds the exit on that
        // same download. The guard decides from what this app open already established; with
        // nothing established, the service is left exactly as it is.
        state.noInspection = true;

        await mountAndQuit();

        expect(inspectMock).not.toHaveBeenCalled();
        expect(peekMock).not.toHaveBeenCalled();
        expect(presentConsentMock).not.toHaveBeenCalled();
        expect(stopBackgroundServiceMock).not.toHaveBeenCalled();
        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_finish_shutdown');
    });

    it('survives a quit the native side cannot finish', async () => {
        // The webview is being torn down around this handler; a rejected invoke must not become an
        // unhandled rejection.
        state.finishThrows = true;

        await mountAndQuit();

        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_finish_shutdown');
    });

    it('survives an event subscription that cannot be established', async () => {
        state.listenThrows = true;

        await act(async () => {
            renderer.create(<DesktopBackgroundServiceCloseGuard enabled />);
        });
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

        expect(listeners).toHaveLength(0);
    });

    it('leaves the service running when the local inspection could not say', async () => {
        state.inspectionFailed = true;

        await mountAndQuit();

        expect(stopBackgroundServiceMock).not.toHaveBeenCalled();
        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_finish_shutdown');
    });

    it('still quits when the stop command itself fails', async () => {
        state.stopThrows = true;

        await mountAndQuit();

        expect(invokeTauriMock).toHaveBeenCalledWith('desktop_finish_shutdown');
    });

    it('does nothing at all on a non-desktop mount', async () => {
        await act(async () => {
            renderer.create(<DesktopBackgroundServiceCloseGuard enabled={false} />);
        });

        expect(listeners).toHaveLength(0);
    });
});
