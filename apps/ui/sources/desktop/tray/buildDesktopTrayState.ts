import type {
    ConnectionHealthKind,
    ConnectionHealthMachineLabelKey,
    ConnectionHealthStatusLabelKey,
} from '@/components/navigation/connectionStatus/connectionHealthTypes';

/** The tray icon is the plain Happier mark; the status is read in its menu as "label · detail". */
export type DesktopTrayState = Readonly<{
    label: string;
    detail: string;
    /** The tray menu's own items, localized here because the native menu cannot translate (U14). */
    openLabel: string;
    quitLabel: string;
    /**
     * R13 (e) — the one optional "Updates available (3)…" item, localized here; absent when there
     * is nothing to act on, which is also what older native shells expect.
     */
    updatesLabel?: string;
    /** `false` while the item only reports ("Updating…"); absent = enabled (older payloads). */
    updatesEnabled?: boolean;
}>;

type TrayLabelKey = ConnectionHealthStatusLabelKey | ConnectionHealthMachineLabelKey | 'settingsDesktop.trayOpen' | 'settingsDesktop.trayQuit';

/**
 * When the one "this computer" projection has something to say, it is the truest description the
 * tray can give — including when the account has no machine, or only offline ones, because the
 * reason is usually this computer's daemon being connected somewhere else (U7). Server-level
 * failures keep their own status: they are about the connection, not about this computer.
 */
const HEALTH_KINDS_THAT_DEFER_TO_THIS_COMPUTER: ReadonlySet<ConnectionHealthKind> = new Set(['healthy', 'no_machine', 'machine_offline']);

export function buildDesktopTrayState(params: Readonly<{
    health: Readonly<{
        kind: ConnectionHealthKind;
        machineCount: number;
        onlineCount: number;
        statusLabelKey: ConnectionHealthStatusLabelKey;
        machineLabelKey: ConnectionHealthMachineLabelKey;
    }>;
    /** The drift summary's one sentence naming what this computer is connected to (U7/R17). */
    thisComputerSentence?: string | null;
    /** The Updates summary's tray item (`describeUpdatesTrayItem`); `null` = no item. */
    updatesItem?: Readonly<{ label: string; enabled: boolean }> | null;
    t: (key: TrayLabelKey) => string;
}>): DesktopTrayState {
    const menuLabels = {
        openLabel: params.t('settingsDesktop.trayOpen'),
        quitLabel: params.t('settingsDesktop.trayQuit'),
        ...(params.updatesItem ? { updatesLabel: params.updatesItem.label, updatesEnabled: params.updatesItem.enabled } : null),
    };
    const sentence = typeof params.thisComputerSentence === 'string'
        ? params.thisComputerSentence.trim()
        : '';
    if (sentence && HEALTH_KINDS_THAT_DEFER_TO_THIS_COMPUTER.has(params.health.kind)) {
        return {
            label: params.t('status.actionRequired'),
            detail: sentence,
            ...menuLabels,
        };
    }

    const label = params.t(params.health.statusLabelKey);
    const machineLabel = params.t(params.health.machineLabelKey);
    const showCounts = params.health.machineCount > 0;

    return {
        label,
        detail: showCounts ? `${machineLabel} · ${params.health.onlineCount}/${params.health.machineCount}` : machineLabel,
        ...menuLabels,
    };
}
