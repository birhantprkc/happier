import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { PressableSurface } from '@/components/ui/interaction/PressableSurface';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { UpdatesSummary } from '@/updates/items/buildUpdatesSummary';
import { useUpdatesContentModel } from '@/updates/useUpdatesContentModel';
import { useUpdatesSummary } from '@/updates/useUpdatesSummary';

import { UpdatesContent } from './UpdatesContent';
import { UPDATES_ROUTE } from './updatesRoute';


type PillCopy = Readonly<{ icon: IconName | 'spinner'; label: string; count?: number; a11y: string; warning: boolean }>;

/** The one mapping from the summary to the entry's mark, words and accessible name. */
export function describeUpdatesEntry(summary: UpdatesSummary): PillCopy | null {
    switch (summary.phase) {
        case 'none':
            return null;
        case 'required':
            return { icon: 'warning-circle', label: t('updates.pill.required'), a11y: t('updates.a11y.pillRequired'), warning: true };
        case 'running':
            return { icon: 'spinner', label: t('updates.pill.running'), a11y: t('updates.a11y.pillRunning'), warning: false };
        case 'failed':
            return { icon: 'warning-circle', label: t('updates.pill.failed'), a11y: t('updates.a11y.pillFailed'), warning: true };
        case 'ready':
            return { icon: 'arrows-clockwise', label: t('updates.pill.ready'), a11y: t('updates.a11y.pillReady'), warning: false };
        case 'completed':
            return { icon: 'check', label: t('updates.pill.completed'), a11y: t('updates.a11y.pillCompleted'), warning: false };
        case 'available':
            return {
                icon: 'arrow-circle-up',
                label: t('updates.pill.updates', { count: summary.actionableCount }),
                count: summary.actionableCount,
                a11y: t('updates.a11y.pillAvailable', { count: summary.actionableCount }),
                warning: false,
            };
    }
}

/** Mounted only while the popover is open: the detail model never runs behind a closed pill. */
const UpdatesPopoverContent = React.memo(function UpdatesPopoverContent(props: Readonly<{ close: () => void }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const model = useUpdatesContentModel();
    const openScreen = React.useCallback(() => {
        props.close();
        router.push(UPDATES_ROUTE);
    }, [props, router]);
    return (
        <>
            <UpdatesContent model={model} presentation="popover" />
            <Pressable
                testID="updates.open_full"
                accessibilityRole="button"
                accessibilityLabel={t('updates.action.openUpdates')}
                onPress={openScreen}
                style={({ pressed }) => [styles.openButton, pressed ? styles.openButtonPressed : null]}
            >
                <Text style={styles.openText}>{t('updates.action.openUpdates')}</Text>
                <Icon name="arrow-square-out" size={ICON_SIZE.sm} color={theme.colors.text.primary} />
            </Pressable>
        </>
    );
});

type WebRect = Readonly<{ left: number; top: number; width: number; height: number }>;

function readWebRect(event: unknown): WebRect | null {
    if (Platform.OS !== 'web') return null;
    const target = (event as { currentTarget?: { getBoundingClientRect?: () => WebRect } } | undefined)?.currentTarget;
    return target?.getBoundingClientRect?.() ?? null;
}

/**
 * The Updates entry in chrome. It reads only the stable summary; the detail model mounts inside the
 * open popover. `pill` sits after the sidebar title (and in the signed-out desktop shell), `rail` is
 * the collapsed sidebar's icon with a count, `header` is the phone Home header's entry and pushes
 * Settings › Updates instead of opening a popover. Hidden when there is nothing to act on.
 */
export const UpdatesPopoverButton = React.memo(function UpdatesPopoverButton(props: Readonly<{
    summary: UpdatesSummary;
    variant: 'pill' | 'rail' | 'header';
    /** Narrow sidebar: keep the mark and the count, drop the words (the accessible name keeps them). */
    compactLabel?: boolean;
    buttonSize?: number;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const [webAnchorRect, setWebAnchorRect] = React.useState<WebRect | null>(null);
    const close = React.useCallback(() => setOpen(false), []);
    const copy = describeUpdatesEntry(props.summary);
    if (!copy && !open) return null;

    const onPress = (event: unknown) => {
        if (props.variant === 'header') {
            router.push(UPDATES_ROUTE);
            return;
        }
        if (!open) setWebAnchorRect(readWebRect(event));
        setOpen((current) => !current);
    };

    const mark = (size: number, color: string) => copy?.icon === 'spinner'
        ? <ActivitySpinner size={iconMatchedSpinnerSize(size)} color={color} />
        : <Icon name={(copy?.icon ?? 'arrow-circle-up') as IconName} size={size} color={color} />;

    const trigger = props.variant === 'rail' ? (
        <Pressable
            testID={props.testID ?? 'updates.entry.rail'}
            accessibilityRole="button"
            accessibilityLabel={copy?.a11y ?? t('updates.title')}
            accessibilityState={{ expanded: open }}
            hitSlop={8}
            onPress={onPress}
            style={[styles.railButton, { width: props.buttonSize ?? 32, height: props.buttonSize ?? 32, borderRadius: (props.buttonSize ?? 32) / 2 }]}
        >
            <View style={styles.railGlyph}>
                {mark(ICON_SIZE.sm, copy?.warning ? theme.colors.state.warning.foreground : theme.colors.chrome.header.foreground)}
                {copy?.count ? (
                    <TabBadge variant="count" tone="neutral" size="compact" value={copy.count} style={styles.railBadge} />
                ) : null}
            </View>
        </Pressable>
    ) : (
        <PressableSurface
            testID={props.testID ?? `updates.entry.${props.variant}`}
            accessibilityRole="button"
            accessibilityLabel={copy?.a11y ?? t('updates.title')}
            accessibilityState={{ expanded: open }}
            hitSlop={Platform.select({ web: 6, default: 12 })}
            focusRingRadius={10}
            onPress={onPress}
            style={styles.pillPressable}
        >
            <StatusPill
                variant={copy?.warning ? 'warning' : 'neutral'}
                labelVariant="phrase"
                leading={mark(ICON_SIZE.xs, copy?.warning ? theme.colors.state.warning.onTint : theme.colors.state.neutral.onTint)}
                count={copy?.count}
                label={props.compactLabel && copy?.count ? '' : (copy?.label ?? '')}
                accessibilityLabel={copy?.a11y}
                labelNumberOfLines={1}
            />
        </PressableSurface>
    );

    return (
        <View ref={anchorRef} collapsable={false} style={styles.anchor}>
            {trigger}
            {open ? (
                <Popover
                    open
                    anchorRef={anchorRef}
                    anchor={webAnchorRect ? { kind: 'rect', rect: webAnchorRect, coordinateSpace: 'window' } : undefined}
                    boundaryRef={null}
                    placement="bottom"
                    edgePadding={{ horizontal: 12, vertical: 12 }}
                    portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false, anchorAlign: props.variant === 'rail' ? 'end' : 'start' }}
                    maxWidthCap={420}
                    maxHeightCap={560}
                    onRequestClose={close}
                >
                    {({ maxHeight, maxWidth }) => (
                        <FloatingOverlay
                            maxHeight={Math.min(maxHeight, 560)}
                            edgeFades={{ top: true, bottom: true, size: 18 }}
                            edgeIndicators
                            surfaceChrome="theme"
                            containerStyle={{ width: Math.min(maxWidth, 400) }}
                        >
                            <UpdatesPopoverContent close={close} />
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    anchor: {
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    pillPressable: {
        borderRadius: 8,
    },
    railButton: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    railGlyph: {
        position: 'relative',
        alignItems: 'center',
        justifyContent: 'center',
    },
    railBadge: {
        position: 'absolute',
        top: -6,
        right: -9,
    },
    openButton: {
        minHeight: 48,
        paddingHorizontal: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    openButtonPressed: {
        opacity: 0.72,
    },
    openText: {
        fontSize: 14,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
}));

/** Chrome mount point: reads the summary itself, so hosts pass no update plumbing. */
export const UpdatesEntry = React.memo(function UpdatesEntry(props: Readonly<{
    variant: 'pill' | 'rail' | 'header';
    compactLabel?: boolean;
    buttonSize?: number;
    testID?: string;
}>) {
    const summary = useUpdatesSummary();
    return <UpdatesPopoverButton summary={summary} {...props} />;
});
