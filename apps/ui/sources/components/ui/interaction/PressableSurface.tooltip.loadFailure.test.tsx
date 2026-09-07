import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' }, View: 'View', Pressable: 'Pressable' });
});

class AppFailureProbe extends React.Component<React.PropsWithChildren, { failed: boolean }> {
    override state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    override render() { return this.state.failed ? React.createElement('AppFailed') : this.props.children; }
}

it('contains a tooltip chunk failure, reports it, and retries when focus follows the failed hover', async () => {
    const transportError = new TypeError('Failed to fetch');
    // External browser module transport: keep the real trigger and loading lifecycle.
    vi.doMock('@/components/ui/overlays/AnchoredTooltip', () => { throw transportError; });
    const { PressableSurface } = await import('./PressableSurface');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onPress = vi.fn();
    try {
        const screen = await renderScreen(
            <AppFailureProbe>
                <PressableSurface testID="action" accessibilityLabel="Next file" webTooltip="Next file" onPress={onPress} />
            </AppFailureProbe>,
        );
        await act(async () => {
            screen.findByTestId('action')?.props.onHoverIn();
            await vi.dynamicImportSettled();
        });
        expect(screen.findByTestId('action')).toBeTruthy();
        expect(warning.mock.calls.flat().some((value) => value === transportError || (value instanceof Error && value.cause === transportError))).toBe(true);
        await screen.pressByTestIdAsync('action');
        expect(onPress).toHaveBeenCalledOnce();
        vi.doMock('@/components/ui/overlays/AnchoredTooltip', () => ({
            default: () => React.createElement('LoadedTooltip', { testID: 'loaded-tooltip' }),
        }));
        await act(async () => {
            screen.findByTestId('action')?.props.onFocus();
            await vi.dynamicImportSettled();
        });
        expect(screen.findByTestId('loaded-tooltip')).toBeTruthy();
        expect(screen.findByTestId('action')).toBeTruthy();
    } finally {
        vi.doUnmock('@/components/ui/overlays/AnchoredTooltip');
        warning.mockRestore();
        errorLog.mockRestore();
    }
});
