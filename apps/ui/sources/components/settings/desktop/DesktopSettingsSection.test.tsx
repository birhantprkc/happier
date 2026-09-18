import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const setEnabledMock = vi.fn(async () => {});
const desktopAutostartState = {
    supported: true,
    enabled: false,
    loading: false,
    error: null as string | null,
    setEnabled: setEnabledMock,
};

const setBackgroundServiceModeMock = vi.fn(async () => {});
const backgroundServiceState = {
    supported: true,
    mode: 'at-login' as 'at-login' | 'on-demand' | null,
    loading: false,
    error: null as string | null,
    setMode: setBackgroundServiceModeMock,
};

function createPassthroughComponentMock(tag: string) {
    return (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(tag, props, props.children);
}

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

vi.mock('./useDesktopAutostart', () => ({
    useDesktopAutostart: () => desktopAutostartState,
}));

vi.mock('./useDesktopBackgroundServiceAutostart', () => ({
    useDesktopBackgroundServiceAutostart: () => backgroundServiceState,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: createPassthroughComponentMock('ItemGroup'),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: createPassthroughComponentMock('Item'),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: createPassthroughComponentMock('Switch'),
}));

describe('DesktopSettingsSection', () => {
    beforeEach(() => {
        desktopAutostartState.supported = true;
        desktopAutostartState.enabled = false;
        desktopAutostartState.loading = false;
        desktopAutostartState.error = null;
        setEnabledMock.mockReset();
        backgroundServiceState.supported = true;
        backgroundServiceState.mode = 'at-login';
        backgroundServiceState.loading = false;
        backgroundServiceState.error = null;
        setBackgroundServiceModeMock.mockReset();
    });

    it('renders nothing when desktop autostart is unsupported', async () => {
        desktopAutostartState.supported = false;
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);

        expect(screen.findGroup('settingsDesktop.title')).toBeNull();
    });

    it('renders a launch-at-login switch row and toggles it through the hook', async () => {
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);
        const row = screen.findRow('settings-desktop-autostart-enabled');

        expect(row?.props.rightElement).toBeTruthy();

        row?.props.rightElement.props.onValueChange(true);

        expect(setEnabledMock).toHaveBeenCalledWith(true);
    });

    it('renders the background-service row beside the app row and reflects the installed mode', async () => {
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);

        // Both rows live in the one desktop group; the app row is untouched by this one.
        expect(screen.findRow('settings-desktop-autostart-enabled')).toBeTruthy();
        const row = screen.findRow('settings-desktop-background-service-enabled');

        expect(row?.props.rightElement.props.value).toBe(true);
        expect(row?.props.rightElement.props.disabled).toBe(false);
    });

    it('changes the installed service mode through its own hook, never the app autostart one', async () => {
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);

        // The switch is a boolean control over a two-mode fact: the row states the mode the CLI
        // parses, so nothing downstream has to translate a boolean back into one.
        screen.findRow('settings-desktop-background-service-enabled')?.props.rightElement.props.onValueChange(false);

        expect(setBackgroundServiceModeMock).toHaveBeenCalledWith('on-demand');
        expect(setEnabledMock).not.toHaveBeenCalled();
    });

    it('restores the login trigger with the at-login mode', async () => {
        backgroundServiceState.mode = 'on-demand';
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);
        const row = screen.findRow('settings-desktop-background-service-enabled');

        expect(row?.props.rightElement.props.value).toBe(false);
        row?.props.rightElement.props.onValueChange(true);

        expect(setBackgroundServiceModeMock).toHaveBeenCalledWith('at-login');
    });

    it('says plainly what turning the background service off costs', async () => {
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);
        const row = screen.findRow('settings-desktop-background-service-enabled');

        expect(row?.props.title).toBe('settingsDesktop.backgroundServiceTitle');
        expect(row?.props.subtitle).toBe('settingsDesktop.backgroundServiceSubtitle');
    });

    it('offers no switch to flip when the installed CLI cannot report the mode', async () => {
        backgroundServiceState.mode = null;
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);
        const row = screen.findRow('settings-desktop-background-service-enabled');

        expect(row?.props.rightElement.props.disabled).toBe(true);
        expect(row?.props.subtitle).toBe('settingsDesktop.backgroundServiceUnknown');
    });

    it('keeps the app row when the background-service control is unavailable', async () => {
        backgroundServiceState.supported = false;
        const { DesktopSettingsSection } = await import('./DesktopSettingsSection');
        const screen = await renderSettingsView(<DesktopSettingsSection />);

        expect(screen.findRow('settings-desktop-autostart-enabled')).toBeTruthy();
        expect(screen.findRow('settings-desktop-background-service-enabled')).toBeNull();
    });
});
