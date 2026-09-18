import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesktopLocalInspection } from '@/setup/deriveDesktopLocalSetupSnapshot';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The coordinator's one published observation, the way every other desktop reader sees it. */
const store = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const notify = () => {
        for (const listener of Array.from(listeners)) listener();
    };
    return {
        value: { status: 'pending' } as DesktopLocalInspection,
        refreshing: false,
        listeners,
        publish(next: DesktopLocalInspection) {
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

const spies = vi.hoisted(() => ({
    inspect: vi.fn(async () => {}),
    setAutostart: vi.fn(async (_mode: string) => {}),
}));

vi.mock('@/setup/desktopSetupCoordinator', () => ({
    desktopSetupCoordinator: {
        inspect: (...args: unknown[]) => spies.inspect(...(args as [])),
        subscribe: (listener: () => void) => {
            store.listeners.add(listener);
            return () => {
                store.listeners.delete(listener);
            };
        },
        readInspectionSnapshot: () => store.value,
        readInspectionRefreshing: () => store.refreshing,
    },
}));

vi.mock('@/setup/desktopBackgroundServiceControl', () => ({
    setBackgroundServiceAutostart: (mode: string) => spies.setAutostart(mode),
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => true,
}));

import { useDesktopBackgroundServiceAutostart, type DesktopBackgroundServiceAutostartState } from './useDesktopBackgroundServiceAutostart';

function factsWithAutostart(autostart: 'at-login' | 'on-demand' | null): DesktopLocalInspection {
    return {
        status: 'resolved',
        facts: {
            acquisition: { command: '/managed/happier', provenance: 'managed' },
            server: { serverUrl: 'https://relay.example.test', publicServerUrl: null, localServerUrl: null, comparableKey: null },
            auth: { credentialState: 'valid', validatedAccountId: 'acct_app', accountId: 'acct_app', machineId: 'machine-1' },
            service: { installed: true, running: true, autostart, targetMode: 'default-following' },
            runtimeConvergence: {
                controlReachable: true,
                serviceOwnsRunningDaemon: true,
                machineIdMatches: true,
                cliVersionMatches: true,
            },
        },
    };
}

let observed: DesktopBackgroundServiceAutostartState | null = null;

async function renderHook(): Promise<void> {
    function Probe() {
        observed = useDesktopBackgroundServiceAutostart();
        return null;
    }
    await act(async () => {
        renderer.create(<Probe />);
    });
}

describe('useDesktopBackgroundServiceAutostart', () => {
    beforeEach(() => {
        store.reset();
        spies.inspect.mockClear();
        spies.setAutostart.mockClear();
        observed = null;
    });

    it('reads the mode from the one shared observation, and follows it when anyone re-reads (F6)', async () => {
        store.publish(factsWithAutostart('at-login'));

        await renderHook();
        expect(observed?.mode).toBe('at-login');

        // Another reader re-reads — the gate's post-setup proof, the Machines refresh, or a mode
        // changed in a terminal. Keeping a private copy of the answer meant this row went on
        // claiming the old mode until it was remounted.
        await act(async () => {
            store.publish(factsWithAutostart('on-demand'));
        });

        expect(observed?.mode).toBe('on-demand');
        // One reader of the one inspection: nothing here starts a second local status read.
        expect(spies.inspect.mock.calls.every((call) => call.length === 0)).toBe(true);
    });

    it('says nothing about a mode the CLI could not report', async () => {
        store.publish(factsWithAutostart(null));

        await renderHook();

        expect(observed?.mode).toBeNull();
    });

    it('writes through the CLI command and re-reads for every reader', async () => {
        store.publish(factsWithAutostart('at-login'));
        await renderHook();

        await act(async () => {
            await observed?.setMode('on-demand');
        });

        expect(spies.setAutostart).toHaveBeenCalledWith('on-demand');
        expect(spies.inspect).toHaveBeenCalledWith({ fresh: true });
    });

    it('reports a failed read instead of a mode nobody proved', async () => {
        store.publish({ status: 'failed', error: { code: 'cli_spawn_failed', message: 'boom' } });

        await renderHook();

        expect(observed?.mode).toBeNull();
        expect(observed?.error).toBe('boom');
    });
});
