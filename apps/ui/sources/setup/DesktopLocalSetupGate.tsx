import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { MainView } from '@/components/navigation/shell/MainView';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { toRelayHostDisplay } from '@/sync/domains/server/url/serverUrlDisplay';

import { SetupSurface, type SetupSurfaceMaterial } from './SetupSurface';
import type { SetupLocalFacts, SetupStartFailure } from './setupStageModel';
import { useDesktopLocalSetupGate, type DesktopLocalSetupGate as DesktopLocalSetupGateState } from './useDesktopLocalSetupGate';

function resolveStartFailure(gate: DesktopLocalSetupGateState): SetupStartFailure | null {
    if (gate.snapshot.reason === 'inspection_failed' && gate.inspection.status === 'failed') {
        return gate.inspection.error;
    }
    if (gate.setupTask.startError) {
        return { code: 'system_task_start_failed', message: gate.setupTask.startError };
    }
    return null;
}

/**
 * Keeps the surface mounted for its one departure beat after the facts say `shell`, on the
 * material it was showing — a veil departs as a veil, not as a sudden opaque ground.
 *
 * The shell is live underneath from the first frame of that beat: this holds the surface long
 * enough to leave rather than be cut, and nothing waits on it.
 */
function useDepartingSurface(material: SetupSurfaceMaterial | null): Readonly<{
    material: SetupSurfaceMaterial | null;
    exiting: boolean;
    onExited: () => void;
}> {
    const [departing, setDeparting] = React.useState<SetupSurfaceMaterial | null>(null);
    const lastShownRef = React.useRef<SetupSurfaceMaterial | null>(material);
    React.useEffect(() => {
        if (material != null) {
            lastShownRef.current = material;
            setDeparting(null);
            return;
        }
        const previous = lastShownRef.current;
        if (previous == null) return;
        lastShownRef.current = null;
        setDeparting(previous);
    }, [material]);
    const onExited = React.useCallback(() => setDeparting(null), []);
    return { material: material ?? departing, exiting: material == null, onExited };
}

const styles = StyleSheet.create(() => ({
    root: {
        flex: 1,
    },
}));

/**
 * The authenticated desktop root (R14). Right after authenticating, unresolved facts show the
 * opaque setup ground — never a brief shell frame. On an ordinary relaunch the shell renders
 * while facts resolve; once facts prove the runtime unconfigured, setup runs under a veil over
 * the shell. The shell reveals when the pure snapshot says `ready`, and the surface leaves on its
 * own beat over it.
 *
 * Both are rendered from ONE tree, in fixed slots: the shell the user was looking at survives a
 * maintenance pass — its scroll position, lists and in-flight animations included — instead of
 * remounting each time the veil arrives or leaves.
 */
export function DesktopLocalSetupGate(): React.ReactElement {
    const gate = useDesktopLocalSetupGate({ enabled: true });
    const relayDisplayName = toRelayHostDisplay(getActiveServerSnapshot().serverUrl);
    const presentation = gate.snapshot.presentation;
    const surface = useDepartingSurface(presentation === 'shell' ? null : presentation);

    // While the inspection is pending there is nothing true to report about a run: a Retry press
    // must return the surface to "checking" on the next frame rather than leaving the failure that
    // is being retried on screen (`DESIGN.md`: acknowledge input immediately). The same expression
    // covers the start of a run — a started setup with no task reported yet is still a check, not
    // work to announce.
    const run = gate.inspection.status === 'pending' ? null : gate.setupTask.activeTaskSnapshot;
    const facts: SetupLocalFacts = {
        relayDisplayName,
        entry: run == null ? 'checking' : 'setup',
        // A settled proof failure is named, so the surface says which one happened and offers a
        // Retry instead of spinning on a run that already finished (INV8/INV10).
        verification: gate.verification.status === 'blocked' ? gate.verification.code : 'pending',
        // The code chooses the sentence and the message is the diagnostic behind Details, so the
        // failed inspection travels as both rather than as one raw string doing two jobs. A
        // `start()` rejection carries no code of its own, so it takes the one the coordinator
        // already uses for the same class of failure.
        startFailure: resolveStartFailure(gate),
    };

    return (
        <View style={styles.root}>
            {/* D9 — the shell is never pre-mounted under the first-run ground. */}
            {presentation === 'ground' ? null : <MainView variant="phone" />}
            {surface.material != null ? (
                <SetupSurface
                    run={run}
                    facts={facts}
                    material={surface.material}
                    onRetry={gate.retry}
                    exiting={surface.exiting}
                    onExited={surface.onExited}
                    testID="desktop-setup-gate"
                />
            ) : null}
        </View>
    );
}
