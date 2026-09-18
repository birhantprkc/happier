import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    DESKTOP_SIDEBAR_CHROME_HORIZONTAL_PADDING_PX,
    DESKTOP_SIDEBAR_CHROME_TOP_PADDING_PX,
} from '@/components/navigation/shell/desktopChrome/desktopChromeMetrics';

/**
 * The desktop window chrome on the setup surface. It only exists on the Tauri desktop host, so
 * these cases run against the testkit's web `react-native` mock rather than the shared node stub.
 */
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return await createReactNativeWebMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => true,
}));

vi.mock('@/components/navigation/shell/desktopChrome/useResolvedDesktopWindowControls', () => ({
    useResolvedDesktopWindowControls: () => React.createElement('WindowControls'),
}));

import { SetupSurface } from './SetupSurface';
import type { SetupLocalFacts } from './setupStageModel';

const FACTS: SetupLocalFacts = { relayDisplayName: 'relay.example.test', entry: 'setup', startFailure: null };

describe('SetupSurface desktop chrome', () => {
    it('keeps the window controls and the drag strip live on the first-run ground', async () => {
        const screen = await renderScreen(<SetupSurface run={null} facts={FACTS} material="ground" />);

        expect(screen.findByTestId('setup-surface-desktop-chrome')).not.toBeNull();
        expect(screen.findByTestId('desktop-main-content-drag-surface')).not.toBeNull();
    });

    it('keeps them live under the maintenance veil, which covers the shell chrome', async () => {
        const screen = await renderScreen(<SetupSurface run={null} facts={FACTS} material="veil" />);

        // The veil owns the whole window while it is up: minimise/maximise/close and the titlebar
        // drag region must belong to it, not to the shell it is covering.
        expect(screen.findByTestId('setup-surface:veil')).not.toBeNull();
        expect(screen.findByTestId('setup-surface-desktop-chrome')).not.toBeNull();
        expect(screen.findByTestId('desktop-main-content-drag-surface')).not.toBeNull();
    });

    it('lands the controls on the same pixels as the shell title row, so the reveal does not jump', async () => {
        const screen = await renderScreen(<SetupSurface run={null} facts={FACTS} material="ground" />);

        const chrome = Object.assign(
            {},
            ...[screen.findByTestId('setup-surface-desktop-chrome')?.props.style].flat().filter(Boolean),
        );
        expect(chrome.top).toBe(DESKTOP_SIDEBAR_CHROME_TOP_PADDING_PX);
        expect(chrome.left).toBe(DESKTOP_SIDEBAR_CHROME_HORIZONTAL_PADDING_PX);
    });
});
