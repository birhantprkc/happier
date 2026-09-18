import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { renderScreen, standardCleanup } from '@/dev/testkit';

const state = vi.hoisted(() => ({
    authenticatedThisRun: true,
    inspection: { status: 'pending' } as unknown,
    snapshotPresentation: 'ground' as 'ground' | 'shell' | 'veil',
    snapshotState: 'checking' as 'checking' | 'setup' | 'ready' | 'blocked',
    activeTaskSnapshot: null as SystemTaskRunState | null,
    serverUrl: 'https://relay.example.test',
}));

/** Mount/unmount counters: "the shell never remounts" is only observable as a count. */
const shell = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock('@/components/navigation/shell/MainView', () => ({
    MainView: (props: Record<string, unknown>) => {
        React.useEffect(() => {
            shell.mounts += 1;
            return () => {
                shell.unmounts += 1;
            };
        }, []);
        return React.createElement('MainView', props);
    },
}));

vi.mock('./SetupSurface', () => ({
    SetupSurface: (props: Record<string, unknown>) => React.createElement('SetupSurface', props),
}));

vi.mock('./useDesktopLocalSetupGate', () => ({
    useDesktopLocalSetupGate: () => ({
        snapshot: { state: state.snapshotState, presentation: state.snapshotPresentation, reason: null },
        inspection: state.inspection,
        verification: { status: 'idle' },
        setupTask: { activeTaskSnapshot: state.activeTaskSnapshot, startError: null },
        retry: () => {},
    }),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'custom-2', serverUrl: state.serverUrl, generation: 1 }),
}));

const FAILED_RUN: SystemTaskRunState = {
    taskId: 'task_1',
    status: 'failed',
    currentStepId: null,
    latestMessage: null,
    awaitingInput: false,
    cancelRequested: false,
    events: [],
    result: {
        protocolVersion: 1,
        taskId: 'task_1',
        ok: false,
        error: { code: 'service_install_blocked', message: 'systemd user bus unavailable' },
    },
} as unknown as SystemTaskRunState;

describe('DesktopLocalSetupGate', () => {
    beforeEach(() => {
        state.authenticatedThisRun = true;
        state.snapshotPresentation = 'ground';
        state.snapshotState = 'checking';
        state.inspection = { status: 'pending' };
        state.activeTaskSnapshot = null;
        state.serverUrl = 'https://relay.example.test';
        shell.mounts = 0;
        shell.unmounts = 0;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('shows the opaque setup ground and no shell frame while facts are unresolved after authenticating (B3/R14)', async () => {
        const { DesktopLocalSetupGate } = await import('./DesktopLocalSetupGate');
        const screen = await renderScreen(React.createElement(DesktopLocalSetupGate));

        expect(screen.findAllByType('MainView' as never)).toHaveLength(0);
        const surface = screen.findByType('SetupSurface' as never);
        expect(surface.props.material).toBe('ground');
        expect(surface.props.facts.entry).toBe('checking');
    });

    it('shows the shell while facts resolve on an ordinary relaunch', async () => {
        state.snapshotPresentation = 'shell';
        const { DesktopLocalSetupGate } = await import('./DesktopLocalSetupGate');
        const screen = await renderScreen(React.createElement(DesktopLocalSetupGate));

        expect(screen.findByType('MainView' as never)).toBeTruthy();
        expect(screen.findAllByType('SetupSurface' as never)).toHaveLength(0);
    });

    it('converges over the shell under a veil once relaunch facts prove the runtime unconfigured (R14)', async () => {
        state.snapshotPresentation = 'veil';
        state.snapshotState = 'setup';
        state.inspection = { status: 'resolved' };
        state.activeTaskSnapshot = FAILED_RUN;
        const { DesktopLocalSetupGate } = await import('./DesktopLocalSetupGate');
        const screen = await renderScreen(React.createElement(DesktopLocalSetupGate));

        expect(screen.findByType('MainView' as never)).toBeTruthy();
        const surface = screen.findByType('SetupSurface' as never);
        expect(surface.props.material).toBe('veil');
        expect(surface.props.facts.entry).toBe('setup');
    });

    it('reveals the shell alone once the snapshot says ready', async () => {
        state.snapshotPresentation = 'shell';
        state.snapshotState = 'ready';
        const { DesktopLocalSetupGate } = await import('./DesktopLocalSetupGate');
        const screen = await renderScreen(React.createElement(DesktopLocalSetupGate));

        expect(screen.findByType('MainView' as never)).toBeTruthy();
        expect(screen.findAllByType('SetupSurface' as never)).toHaveLength(0);
    });

    it('keeps the shell mounted through maintenance: the veil arrives and leaves without remounting it', async () => {
        state.snapshotPresentation = 'shell';
        state.snapshotState = 'ready';
        const { DesktopLocalSetupGate } = await import('./DesktopLocalSetupGate');
        const screen = await renderScreen(React.createElement(DesktopLocalSetupGate));
        expect(shell.mounts).toBe(1);

        state.snapshotPresentation = 'veil';
        state.snapshotState = 'setup';
        await act(async () => {
            screen.tree.update(React.createElement(DesktopLocalSetupGate));
        });
        expect(screen.findByType('SetupSurface' as never).props.material).toBe('veil');

        state.snapshotPresentation = 'shell';
        state.snapshotState = 'ready';
        await act(async () => {
            screen.tree.update(React.createElement(DesktopLocalSetupGate));
        });

        // The shell the user was looking at is the SAME tree throughout: scroll position, list
        // state and in-flight animations survive a maintenance pass.
        expect(shell.mounts).toBe(1);
        expect(shell.unmounts).toBe(0);
    });

    it('gives the surface one exit beat over the revealed shell instead of cutting it', async () => {
        state.snapshotPresentation = 'veil';
        state.snapshotState = 'setup';
        const { DesktopLocalSetupGate } = await import('./DesktopLocalSetupGate');
        const screen = await renderScreen(React.createElement(DesktopLocalSetupGate));
        expect(screen.findByType('SetupSurface' as never).props.exiting).toBeFalsy();

        state.snapshotPresentation = 'shell';
        state.snapshotState = 'ready';
        await act(async () => {
            screen.tree.update(React.createElement(DesktopLocalSetupGate));
        });

        // Readiness is immediate; only the surface's departure takes a beat.
        expect(screen.findByType('MainView' as never)).toBeTruthy();
        const departing = screen.findByType('SetupSurface' as never);
        expect(departing.props.exiting).toBe(true);

        await act(async () => {
            (departing.props.onExited as () => void)();
        });
        expect(screen.findAllByType('SetupSurface' as never)).toHaveLength(0);
    });

    it('acknowledges Retry at once: a pending inspection reads as checking, not as the run that already failed', async () => {
        state.snapshotPresentation = 'ground';
        state.snapshotState = 'blocked';
        state.activeTaskSnapshot = FAILED_RUN;
        state.inspection = { status: 'pending' };
        const { DesktopLocalSetupGate } = await import('./DesktopLocalSetupGate');
        const screen = await renderScreen(React.createElement(DesktopLocalSetupGate));

        const surface = screen.findByType('SetupSurface' as never);
        expect(surface.props.run).toBeNull();
        expect(surface.props.facts.entry).toBe('checking');
    });

    it('reads as checking while a setup start is in flight and no task has been reported yet', async () => {
        state.snapshotPresentation = 'ground';
        state.snapshotState = 'setup';
        state.inspection = { status: 'resolved' };
        state.activeTaskSnapshot = null;
        const { DesktopLocalSetupGate } = await import('./DesktopLocalSetupGate');
        const screen = await renderScreen(React.createElement(DesktopLocalSetupGate));

        expect(screen.findByType('SetupSurface' as never).props.facts.entry).toBe('checking');
    });

    it('names the relay the way the welcome footer does — one host, no scheme', async () => {
        state.serverUrl = 'https://relay.example.test:8443/';
        const { DesktopLocalSetupGate } = await import('./DesktopLocalSetupGate');
        const screen = await renderScreen(React.createElement(DesktopLocalSetupGate));

        expect(screen.findByType('SetupSurface' as never).props.facts.relayDisplayName)
            .toBe('relay.example.test:8443');
    });
});
