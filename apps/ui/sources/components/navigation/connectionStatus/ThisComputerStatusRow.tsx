import * as React from 'react';
import { View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { useRelayDriftSummary } from '@/components/settings/server/useRelayDriftSummary';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/**
 * U7/R17 — the connection popover's "This computer" row: the drift projection's one sentence
 * naming the relay host and account this computer's daemon is connected to, when it contradicts
 * the app. It is its own leaf, mounted only while the popover is open, so the always-mounted status
 * chip never holds the inspection subscription (`apps/ui/AGENTS.md`). Desktop only: no other
 * surface knows this computer's daemon.
 */
export function ThisComputerStatusRow(props: Readonly<{
    rowStyle: StyleProp<ViewStyle>;
    labelStyle: StyleProp<TextStyle>;
    valueStyle: StyleProp<TextStyle>;
}>): React.ReactElement | null {
    const summary = useRelayDriftSummary();
    if (!summary) {
        return null;
    }
    return (
        <View style={props.rowStyle} testID="connection-popover-this-computer">
            <Text style={props.labelStyle}>{t('connectionStatus.labels.thisComputer')}</Text>
            <Text style={props.valueStyle} numberOfLines={3}>{summary.description}</Text>
        </View>
    );
}
