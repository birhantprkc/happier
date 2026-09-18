import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * `move`: reconcile once. `always`: reconcile and remember the choice on this device.
 * `keep`: leave the background service where it is.
 */
export type RelayReconciliationConsentAnswer = 'move' | 'always' | 'keep';

/**
 * UD5's one ask: the app is about to move this device's own default-following background service
 * to the Relay the user just selected, and the current facts did not prove it may do so silently.
 *
 * "Always move it" is the device-local preference, offered only here — the executor's service
 * ownership consent (pinned, manual, foreign-home, conflicting or multiple services) is raised by
 * the CLI through `presentSetupServiceConsent` and is never suppressed by it.
 */
export async function presentRelayReconciliationConsent(params: Readonly<{ relayUrl: string }>): Promise<RelayReconciliationConsentAnswer> {
    let answer: RelayReconciliationConsentAnswer = 'keep';
    await Modal.alertAsync(
        t('setupSurface.relayMoveTitle'),
        t('setupSurface.relayMoveBody', { relay: params.relayUrl }),
        [
            { text: t('setupSurface.relayMoveKeep'), style: 'cancel', onPress: () => { answer = 'keep'; } },
            { text: t('setupSurface.relayMoveAlways'), onPress: () => { answer = 'always'; } },
            { text: t('setupSurface.relayMoveConfirm'), onPress: () => { answer = 'move'; } },
        ],
    );
    return answer;
}
