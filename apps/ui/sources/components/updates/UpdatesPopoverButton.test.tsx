import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type { UpdatesSummary } from '@/updates/items/buildUpdatesSummary';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const routerMock = createExpoRouterMock();
vi.mock('expo-router', () => routerMock.module);

const capture = vi.hoisted(() => ({
    contentModelMounts: 0,
    activeContentModels: 0,
    contentProps: null as Record<string, unknown> | null,
}));

// The detail owner and its content are the leaf this test proves stays unmounted behind a closed
// entry (`apps/ui/AGENTS.md`: always-mounted chrome reads only the summary).
vi.mock('@/updates/useUpdatesContentModel', () => ({
    useUpdatesContentModel: () => {
        capture.contentModelMounts += 1;
        React.useEffect(() => {
            capture.activeContentModels += 1;
            return () => {
                capture.activeContentModels -= 1;
            };
        }, []);
        return { kind: 'model' };
    },
}));

vi.mock('./UpdatesContent', () => ({
    UpdatesContent: (props: Record<string, unknown>) => {
        capture.contentProps = props;
        return React.createElement('UpdatesContent', props);
    },
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: Record<string, unknown> & { children: (layout: { maxHeight: number; maxWidth: number }) => React.ReactNode }) => (
        React.createElement('Popover', props, props.children({ maxHeight: 600, maxWidth: 500 }))
    ),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown>) => React.createElement('FloatingOverlay', props, props.children as React.ReactNode),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const NONE: UpdatesSummary = { actionableCount: 0, failedCount: 0, runningCount: 0, phase: 'none', status: 'upToDate', visible: false };
const TWO: UpdatesSummary = { actionableCount: 2, failedCount: 0, runningCount: 0, phase: 'available', status: 'available', visible: true };

describe('UpdatesPopoverButton', () => {
    it('is absent at zero, and a closed pill never mounts the detail model', async () => {
        capture.contentModelMounts = 0;
        const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');
        const screen = await renderScreen(<UpdatesPopoverButton summary={NONE} variant="pill" testID="pill" />);
        expect(screen.findAllHostsByTestId('pill')).toHaveLength(0);

        await screen.update(<UpdatesPopoverButton summary={TWO} variant="pill" testID="pill" />);
        expect(screen.findByTestId('pill')?.props.accessibilityLabel).toBe('updates.a11y.pillAvailable');
        expect(screen.findByTestId('pill')?.props.accessibilityState).toMatchObject({ expanded: false });
        expect(capture.contentModelMounts).toBe(0);
    });

    it('opens the shared content in the popover density, and unmounts it again on close', async () => {
        capture.contentModelMounts = 0;
        capture.activeContentModels = 0;
        const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');
        const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="pill" testID="pill" />);

        await act(async () => {
            await screen.findByTestId('pill')?.props.onPress({});
        });
        expect(screen.findByTestId('pill')?.props.accessibilityState).toMatchObject({ expanded: true });
        expect(capture.activeContentModels).toBe(1);
        expect(capture.contentProps).toMatchObject({ presentation: 'popover' });

        await screen.pressByTestIdAsync('updates.open_full');
        expect(routerMock.spies.push).toHaveBeenCalledWith('/(app)/settings/updates');
        expect(screen.findAllByType('Popover' as never)).toHaveLength(0);
        expect(capture.activeContentModels).toBe(0);
    });

    it('on the phone header, goes to Settings › Updates instead of opening a popover', async () => {
        capture.contentModelMounts = 0;
        routerMock.spies.push.mockClear();
        const { UpdatesPopoverButton } = await import('./UpdatesPopoverButton');
        const screen = await renderScreen(<UpdatesPopoverButton summary={TWO} variant="header" testID="header" />);
        await act(async () => {
            await screen.findByTestId('header')?.props.onPress({});
        });
        expect(routerMock.spies.push).toHaveBeenCalledWith('/(app)/settings/updates');
        expect(capture.contentModelMounts).toBe(0);
    });
});
