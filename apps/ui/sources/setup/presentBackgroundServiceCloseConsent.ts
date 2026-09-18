import { Modal } from '@/modal';
import { t } from '@/text';

/** `stop`: stop the background service anyway. `keep`: leave it running. */
export type BackgroundServiceCloseConsentAnswer = 'stop' | 'keep';

/**
 * The one ask on quit: the user turned login start off, so closing the app should stop the
 * background service — but agent sessions are still running on this computer and stopping it now
 * would end them.
 *
 * Cancelling means keep, and so does dismissing: the only answer that ends someone's work is the
 * one they gave on purpose.
 */
export async function presentBackgroundServiceCloseConsent(): Promise<BackgroundServiceCloseConsentAnswer> {
    let answer: BackgroundServiceCloseConsentAnswer = 'keep';
    await Modal.alertAsync(
        t('settingsDesktop.closeStopTitle'),
        t('settingsDesktop.closeStopBody'),
        [
            { text: t('settingsDesktop.closeStopKeep'), style: 'cancel', onPress: () => { answer = 'keep'; } },
            { text: t('settingsDesktop.closeStopConfirm'), style: 'destructive', onPress: () => { answer = 'stop'; } },
        ],
    );
    return answer;
}
