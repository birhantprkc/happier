import * as React from 'react';

import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { t } from '@/text';

import { useDesktopAutostart } from './useDesktopAutostart';
import { useDesktopBackgroundServiceAutostart } from './useDesktopBackgroundServiceAutostart';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * One truthful sentence for the background-service row (U12): not set up yet is not the same as a
 * CLI that cannot report its mode, and a failed change is said in words — the raw error is a
 * diagnostic, not a subtitle.
 */
function resolveBackgroundServiceSubtitle(state: ReturnType<typeof useDesktopBackgroundServiceAutostart>): string {
    if (state.installed === false) {
        return t('settingsDesktop.backgroundServiceNotSetUp');
    }
    if (state.mode === null) {
        return t('settingsDesktop.backgroundServiceUnknown');
    }
    return state.error ? t('settingsDesktop.backgroundServiceChangeFailed') : t('settingsDesktop.backgroundServiceSubtitle');
}

export const DesktopSettingsSection = React.memo(function DesktopSettingsSection() {
    const { theme } = useUnistyles();
    const autostart = useDesktopAutostart();
    const backgroundService = useDesktopBackgroundServiceAutostart();

    if (!autostart.supported) {
        return null;
    }

    return (
        <ItemGroup
            title={t('settingsDesktop.title')}
            footer={t('settingsDesktop.footer')}
        >
            <Item
                testID="settings-desktop-autostart-enabled"
                title={t('settingsDesktop.startOnLoginTitle')}
                subtitle={autostart.error ?? t('settingsDesktop.startOnLoginSubtitle')}
                icon={<Icon name="desktop" size={29} color={theme.colors.accent.blue} />}
                rightElement={(
                    <Switch
                        value={autostart.enabled}
                        disabled={autostart.loading}
                        onValueChange={(value) => {
                            void autostart.setEnabled(Boolean(value));
                        }}
                    />
                )}
                showChevron={false}
            />
            {backgroundService.supported ? (
                <Item
                    testID="settings-desktop-background-service-enabled"
                    title={t('settingsDesktop.backgroundServiceTitle')}
                    subtitle={resolveBackgroundServiceSubtitle(backgroundService)}
                    icon={<Icon name="pulse" size={29} color={theme.colors.accent.green} />}
                    rightElement={(
                        <Switch
                            value={backgroundService.mode === 'at-login'}
                            disabled={backgroundService.loading || backgroundService.mode === null}
                            onValueChange={(value) => {
                                // The switch position is presentation; the mode is the contract.
                                void backgroundService.setMode(value ? 'at-login' : 'on-demand');
                            }}
                        />
                    )}
                    showChevron={false}
                />
            ) : null}
        </ItemGroup>
    );
});
