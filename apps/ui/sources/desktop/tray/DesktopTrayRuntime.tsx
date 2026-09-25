import * as React from 'react';

import { useRouter } from 'expo-router';

import { useConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { describeUpdatesTrayItem } from '@/components/updates/describeUpdatesSummary';
import { UPDATES_ROUTE } from '@/components/updates/updatesRoute';
import { useRelayDriftSummary } from '@/components/settings/server/useRelayDriftSummary';
import { t } from '@/text';
import { isTauriDesktop, listenTauriEvent } from '@/utils/platform/tauri';
import { useSharedUpdatesSummary } from '@/updates/useUpdatesSummary';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { applyTauriTrayState } from './applyTauriTrayState';
import { buildDesktopTrayState } from './buildDesktopTrayState';

function TauriDesktopTrayRuntime(): React.ReactElement | null {
    const connectionHealth = useConnectionHealth();
    // The summary projection only: the tray is always mounted, so it must not hold the repair's
    // setup task or prompt handling (`apps/ui/AGENTS.md`).
    const thisComputer = useRelayDriftSummary();
    const updatesItem = describeUpdatesTrayItem(useSharedUpdatesSummary());
    const updatesLabel = updatesItem?.label ?? null;
    const updatesEnabled = updatesItem?.enabled ?? true;
    const router = useRouter();

    const trayState = React.useMemo(() => buildDesktopTrayState({
        health: {
            kind: connectionHealth.kind,
            machineCount: connectionHealth.machineCount,
            onlineCount: connectionHealth.onlineCount,
            statusLabelKey: connectionHealth.statusLabelKey,
            machineLabelKey: connectionHealth.machineLabelKey,
        },
        thisComputerSentence: thisComputer?.description ?? null,
        updatesItem: updatesLabel ? { label: updatesLabel, enabled: updatesEnabled } : null,
        t,
    }), [
        updatesEnabled,
        updatesLabel,
        connectionHealth.kind,
        connectionHealth.machineCount,
        connectionHealth.machineLabelKey,
        connectionHealth.onlineCount,
        connectionHealth.statusLabelKey,
        thisComputer?.description,
    ]);

    React.useEffect(() => {
        fireAndForget(applyTauriTrayState(trayState), {
            tag: 'DesktopTrayRuntime.applyTauriTrayState',
        });
    }, [trayState]);

    // The tray's Updates item shows the window (native side) and asks this webview to open Updates.
    React.useEffect(() => {
        let unlisten: (() => void) | null = null;
        let disposed = false;
        void listenTauriEvent<unknown>(DESKTOP_OPEN_UPDATES_REQUESTED_EVENT, () => {
            router.push(UPDATES_ROUTE);
        }).then((stop) => {
            if (disposed) stop();
            else unlisten = stop;
        }).catch(() => {});
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [router]);

    return null;
}

/** Emitted by the native tray router (`menu.rs` `OPEN_UPDATES_REQUESTED_EVENT`). */
const DESKTOP_OPEN_UPDATES_REQUESTED_EVENT = 'desktop_open_updates_requested';

export function DesktopTrayRuntime(): React.ReactElement | null {
    if (!isTauriDesktop()) return null;
    return <TauriDesktopTrayRuntime />;
}
