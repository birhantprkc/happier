import type { SetupServiceConsentPrompt } from '@/components/systemTasks/useThisComputerSetupTask';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * The focused alert for the executor's service-ownership decision (UD5 / plan L5). The facts are
 * the CLI's (`service install --dry-run --json`, INV9); this only presents them and returns the
 * answer. Nothing here re-evaluates ownership.
 */
export async function presentSetupServiceConsent(prompt: SetupServiceConsentPrompt): Promise<boolean> {
    const services = [...prompt.competingServices, ...prompt.servicesToRemove];
    const detail = prompt.message ?? t('setupSurface.consentBodyFallback');
    const body = services.length > 0
        ? `${detail}\n\n${t('setupSurface.consentServicesList', { services: services.join(', ') })}`
        : detail;
    return await Modal.confirm(
        t('setupSurface.consentTitle'),
        body,
        { confirmText: t('setupSurface.consentConfirm'), cancelText: t('setupSurface.consentKeep') },
    );
}
