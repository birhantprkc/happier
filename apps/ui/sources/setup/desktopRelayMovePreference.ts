import { getStorage } from '@/sync/domains/state/storageStore';
import { applyLocalSettingsFromUi } from '@/sync/store/settingsWriters';

/**
 * UD5's one device-local preference: "always move my default-following background service with my
 * selected default relay". It is stored through the canonical local-settings owner
 * (`LOCAL_SETTING_ARTIFACTS`), so it never syncs to the account and never leaves this device.
 */
export function readAlwaysMoveDefaultFollowingService(): boolean {
    return getStorage().getState().localSettings.desktopAlwaysMoveDefaultFollowingService === true;
}

export function rememberAlwaysMoveDefaultFollowingService(): void {
    applyLocalSettingsFromUi({ desktopAlwaysMoveDefaultFollowingService: true });
}
