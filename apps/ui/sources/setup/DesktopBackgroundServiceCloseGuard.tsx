import * as React from 'react';

import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { invokeTauri, listenTauriEvent } from '@/utils/platform/tauri';

import { stopBackgroundService } from './desktopBackgroundServiceControl';
import { desktopSetupCoordinator } from './desktopSetupCoordinator';
import { presentBackgroundServiceCloseConsent } from './presentBackgroundServiceCloseConsent';
import {
    countActiveLocalAgentSessions,
    resolveDesktopCloseDaemonDecision,
} from './resolveDesktopCloseDaemonDecision';

/** Emitted by `src-tauri/src/shutdown.rs` once per quit, never per window. */
export const DESKTOP_APP_EXIT_REQUESTED_EVENT = 'desktop_app_exit_requested';

/**
 * Honours the background-service preference as the desktop app quits.
 *
 * The native side holds the exit and hands the decision here because only the app knows what is
 * running on this computer and can ask about it. Whatever happens — a failed read, a failed stop,
 * a dismissed question, a thrown anything — the app still quits, and the daemon is only ever
 * stopped by an answer that was actually reached. Nothing is retried and nothing is timed: a quit
 * the webview cannot finish is finished by pressing Quit again.
 */
export function DesktopBackgroundServiceCloseGuard(props: Readonly<{ enabled: boolean }>): null {
    const { enabled } = props;
    React.useEffect(() => {
        if (!enabled) {
            return;
        }

        let cancelled = false;
        let dispose: (() => void) | null = null;
        void listenTauriEvent(DESKTOP_APP_EXIT_REQUESTED_EVENT, () => {
            void (async () => {
                try {
                    // What this app open has already established — never a new read, and never a
                    // wait on one in flight. Starting a read here would begin a managed-CLI
                    // acquisition while the exit is held, and awaiting the warm-up's read would
                    // hold the exit on that same download; the only bound either way is the user
                    // pressing Quit again. Nothing established yet means nothing to act on.
                    const inspection = desktopSetupCoordinator.readInspectionSnapshot();
                    const facts = inspection.status === 'resolved' ? inspection.facts : null;
                    const appAccountId = getActiveServerAccountScope()?.accountId ?? null;
                    const decision = resolveDesktopCloseDaemonDecision({
                        autostart: facts?.service.autostart ?? null,
                        activeLocalSessionCount: countActiveLocalAgentSessions({
                            sessions: Object.values(getStorage().getState().sessions ?? {}),
                            machineId: facts?.auth.machineId ?? null,
                        }),
                        canSeeDaemonSessions: appAccountId !== null && facts?.auth.validatedAccountId === appAccountId,
                    });
                    if (decision === 'ask') {
                        // Quit from the tray leaves the window hidden, so the question would be
                        // asked of a webview nobody can see: the exit is held, Quit looks like it
                        // did nothing, and the deal the toggle made goes unhonoured.
                        await invokeTauri('desktop_show_main_window');
                        if (await presentBackgroundServiceCloseConsent() !== 'stop') {
                            return;
                        }
                    }
                    if (decision === 'stop' || decision === 'ask') {
                        await stopBackgroundService();
                    }
                } catch {
                    // Leave the background service exactly where it is: the app is closing either
                    // way, and no failure here is worth ending someone's running agent session.
                } finally {
                    // The webview is being torn down around this handler, so even finishing the
                    // shutdown can reject; the app still quits either way.
                    void invokeTauri('desktop_finish_shutdown').catch(() => {});
                }
            })();
        }).then(
            (disposeListener) => {
                if (cancelled) {
                    disposeListener();
                    return;
                }
                dispose = disposeListener;
            },
            () => {
                // No exit handoff reaches this app, so there is nothing to guard: the native side
                // finishes the quit on its own and the service is left running.
            },
        );

        return () => {
            cancelled = true;
            dispose?.();
        };
    }, [enabled]);
    return null;
}
