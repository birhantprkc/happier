import { getDisplayName } from '@/sync/domains/profiles/profile';
import { t } from '@/text';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';

import type { DesktopCliChannel } from './deriveDesktopLocalSetupSnapshot';

/**
 * The short form of an account id, for when nothing more readable is known (K1). Long enough to
 * tell two accounts apart at a glance, short enough to sit inside a sentence.
 */
export function formatShortAccountId(accountId: string): string {
    const id = accountId.trim();
    return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/**
 * The account this computer's daemon is signed in as, the way a person reads it: the label the
 * relay's profile gave the CLI (`auth.accountLabel`), else a short id. `null` when the relay
 * validated no account at all.
 */
export function resolveDaemonAccountLabel(auth: Readonly<{ accountLabel: string | null; validatedAccountId: string | null }>): string | null {
    if (auth.accountLabel) return auth.accountLabel;
    return auth.validatedAccountId ? formatShortAccountId(auth.validatedAccountId) : null;
}

/**
 * The account the app is signed in as, labelled the same way as the daemon's so the two read as
 * comparable: the profile's username, else its display name, else a short id. Only the app's own
 * signed-in profile is known here, so any other account id falls back to the short form.
 */
export function resolveAppAccountLabel(accountId: string): string {
    const profile = readRegisteredStorageState()?.profile ?? null;
    if (profile && profile.id === accountId) {
        const label = profile.username ?? getDisplayName(profile);
        if (label) return label;
    }
    return formatShortAccountId(accountId);
}

/**
 * A release channel the way a person reads it ("Stable", "Preview", "Dev"): the channel of the
 * command line this computer runs, which an app of another channel may have adopted (D2).
 */
export function formatCliChannelLabel(channel: DesktopCliChannel): string {
    switch (channel) {
        case 'stable':
            return t('machine.thisComputer.cliChannelStable');
        case 'preview':
            return t('machine.thisComputer.cliChannelPreview');
        case 'publicdev':
            return t('machine.thisComputer.cliChannelDev');
    }
}
