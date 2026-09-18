import * as React from 'react';

import type { DesktopBackgroundServiceAutostartMode } from '@/setup/deriveDesktopLocalSetupSnapshot';
import { setBackgroundServiceAutostart } from '@/setup/desktopBackgroundServiceControl';
import { useDesktopLocalInspection } from '@/setup/useDesktopLocalInspection';
import { isTauriDesktop } from '@/utils/platform/tauri';

/**
 * Whether the Happier background service on this computer starts at login.
 *
 * Shaped like `useDesktopAutostart`, and deliberately separate from it: that one launches the
 * *app* through Tauri, this one changes the *installed service* through the CLI that owns it. The
 * two answer different questions and neither may stand in for the other.
 *
 * `mode` is `null` when the local inspection could not say — an older managed CLI, or a read that
 * failed. Unknown stays unknown: the row says so and offers nothing to flip, rather than showing a
 * switch that would claim the computer behaves a way nobody proved.
 */
export type DesktopBackgroundServiceAutostartState = Readonly<{
    supported: boolean;
    mode: DesktopBackgroundServiceAutostartMode | null;
    loading: boolean;
    error: string | null;
    setMode: (mode: DesktopBackgroundServiceAutostartMode) => Promise<void>;
}>;

function readErrorMessage(error: unknown): string {
    return String((error as Error | undefined)?.message ?? error ?? 'Unknown error');
}

export function useDesktopBackgroundServiceAutostart(): DesktopBackgroundServiceAutostartState {
    const supported = React.useMemo(() => isTauriDesktop(), []);
    const [writing, setWriting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    // The one ambient observation, read where every other desktop surface reads it. This row used
    // to await `inspect()` once and keep the answer, so a mode changed by anyone else — the gate's
    // post-setup re-read, the Machines refresh, `happier service install --autostart …` in a
    // terminal — was not reflected until it remounted.
    const { inspection, refresh } = useDesktopLocalInspection(supported);
    const facts = inspection.status === 'resolved' ? inspection.facts : null;
    const readError = inspection.status === 'failed' ? (inspection.error.message || inspection.error.code) : null;

    const setMode = React.useCallback(async (nextMode: DesktopBackgroundServiceAutostartMode) => {
        if (!supported) {
            return;
        }

        setWriting(true);
        setError(null);
        try {
            await setBackgroundServiceAutostart(nextMode);
            // The executor already proved the change by re-reading the installed definition; the
            // app re-reads too so every later reader — including the app-close guard — sees it.
            refresh();
        } catch (nextError) {
            setError(readErrorMessage(nextError));
        } finally {
            setWriting(false);
        }
    }, [refresh, supported]);

    return {
        supported,
        mode: facts?.service.autostart ?? null,
        loading: supported && (writing || inspection.status === 'pending'),
        error: error ?? readError,
        setMode,
    };
}
