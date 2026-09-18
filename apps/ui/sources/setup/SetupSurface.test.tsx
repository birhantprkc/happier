import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskEvent } from '@happier-dev/protocol';

import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    });
});

const hostVisibleState = vi.hoisted(() => ({ visible: true }));
vi.mock('@/hooks/ui/useIsHostVisible', () => ({
    useIsHostVisible: () => hostVisibleState.visible,
}));

const reducedMotionState = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionState.enabled,
}));

const reduceTransparencyState = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/hooks/ui/useReduceTransparency', () => ({
    useReduceTransparency: () => reduceTransparencyState.enabled,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
}));

vi.mock('@/components/navigation/shell/desktopChrome/useResolvedDesktopWindowControls', () => ({
    useResolvedDesktopWindowControls: () => null,
}));

import { SETUP_SURFACE_EXIT_MS, SetupSurface } from './SetupSurface';
import { SETUP_STAGES, type SetupLocalFacts } from './setupStageModel';

const RELAY = 'relay.example.test';

function facts(overrides: Partial<SetupLocalFacts> = {}): SetupLocalFacts {
    return { relayDisplayName: RELAY, entry: 'setup', startFailure: null, ...overrides };
}

/** Node mocks that can take focus, so "focus moved once" is observable rather than inferred. */
function focusTrackingNodeMocks() {
    const focused: string[] = [];
    return {
        focused,
        createNodeMock: (element: React.ReactElement) => ({
            focus: () => {
                focused.push(String((element.props as { testID?: unknown } | undefined)?.testID ?? ''));
            },
        }),
    };
}

function progress(stepId: string, tsMs: number): SystemTaskEvent {
    return { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', tsMs, type: 'progress', stepId, message: stepId };
}

function runState(overrides: Partial<SystemTaskRunState> = {}): SystemTaskRunState {
    const events = overrides.events ?? [];
    const latest = events[events.length - 1] ?? null;
    return {
        taskId: 'task_1',
        status: 'running',
        currentStepId: latest?.stepId ?? null,
        latestMessage: latest?.message ?? null,
        awaitingInput: false,
        cancelRequested: false,
        events,
        result: null,
        ...overrides,
    };
}

const FAILED = runState({
    status: 'failed',
    events: [progress('setup.thisComputer.installService', 240)],
    result: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        taskId: 'task_1',
        ok: false,
        error: { code: 'service_install_blocked', message: 'systemd user bus unavailable' },
    },
});

const SUCCEEDED = runState({
    status: 'succeeded',
    events: [progress('setup.thisComputer.startService', 240)],
    result: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', ok: true, data: { machineId: 'm' } },
});

function textOf(node: { props: { children?: unknown } } | null): string {
    if (!node) return '';
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
}

beforeEach(() => {
    reducedMotionState.enabled = false;
    reduceTransparencyState.enabled = false;
    hostVisibleState.visible = true;
});

describe('SetupSurface actions (R7)', () => {
    it('renders no action in ordinary progress states', async () => {
        for (const stepId of ['setup.thisComputer.ensureCli', 'setup.thisComputer.configureRelay', 'setup.thisComputer.installService', 'setup.thisComputer.restartService']) {
            const screen = await renderScreen(
                <SetupSurface
                    run={runState({ events: [progress(stepId, 10)] })}
                    facts={facts()}
                    material="ground"
                    onRetry={() => {}}
                />,
            );
            expect(screen.findByTestId('setup-surface:retry')).toBeNull();
            expect(screen.findByTestId('setup-surface:details')).toBeNull();
            expect(screen.findByTestId('setup-surface:working')).not.toBeNull();
        }
    });

    it('renders no action while checking or verifying, and never reaches a success state', async () => {
        const checking = await renderScreen(
            <SetupSurface run={null} facts={facts({ entry: 'checking' })} material="ground" onRetry={() => {}} />,
        );
        expect(checking.findByTestId('setup-surface:checking')).not.toBeNull();
        expect(checking.findByTestId('setup-surface:retry')).toBeNull();

        // Task success opens the verify stage. The host swaps in the shell the moment readiness is
        // proven, so there is no state in which this surface congratulates anyone.
        const verifying = await renderScreen(
            <SetupSurface run={SUCCEEDED} facts={facts()} material="ground" onRetry={() => {}} />,
        );
        expect(verifying.findByTestId('setup-surface:working')).not.toBeNull();
        expect(verifying.findByTestId('setup-surface:complete')).toBeNull();
        expect(verifying.findByTestId('setup-surface:retry')).toBeNull();
        expect(verifying.findByTestId('setup-surface:details')).toBeNull();
    });

    it('offers retry and details only when blocked, each reachable by keyboard', async () => {
        const onRetry = vi.fn();
        const screen = await renderScreen(
            <SetupSurface run={FAILED} facts={facts()} material="ground" onRetry={onRetry} />,
        );

        expect(screen.findByTestId('setup-surface:blocked')).not.toBeNull();
        for (const id of ['setup-surface:retry', 'setup-surface:details']) {
            const node = screen.findByTestId(id);
            expect(node).not.toBeNull();
            // Pressables reach the keyboard as buttons: a role and a name, never a bare view.
            expect(node?.props.accessibilityRole).toBe('button');
            expect(typeof node?.props.accessibilityLabel).toBe('string');
            expect(node?.props.accessibilityLabel.length).toBeGreaterThan(0);
        }

        screen.pressByTestId('setup-surface:retry');
        expect(onRetry).toHaveBeenCalledTimes(1);

        // Details discloses the EXISTING diagnostics card, unchanged.
        expect(screen.findByTestId('system-task-progress-card')).toBeNull();
        await screen.pressByTestIdAsync('setup-surface:details');
        expect(screen.findByTestId('system-task-progress-card')).not.toBeNull();
        expect(screen.findByTestId('system-task-progress-status-failed')).not.toBeNull();
    });
});

describe('SetupSurface material (UD4)', () => {
    it('fills the route on first run and overlays the shell for in-session maintenance', async () => {
        const run = runState({ events: [progress('setup.thisComputer.configureRelay', 120)] });
        const ground = await renderScreen(<SetupSurface run={run} facts={facts()} material="ground" />);
        const veil = await renderScreen(<SetupSurface run={run} facts={facts()} material="veil" />);

        const groundNode = ground.findByTestId('setup-surface:ground');
        expect(groundNode).not.toBeNull();
        expect(ground.findByTestId('setup-surface:veil')).toBeNull();
        const groundStyle = Object.assign({}, ...[groundNode?.props.style].flat().filter(Boolean));
        expect(groundStyle.position).toBeUndefined();
        expect(groundStyle.flex).toBe(1);
        // Opaque: the shell has not been shown, so there is nothing to see through.
        expect(typeof groundStyle.backgroundColor).toBe('string');

        const veilNode = veil.findByTestId('setup-surface:veil');
        expect(veilNode).not.toBeNull();
        expect(veil.findByTestId('setup-surface:ground')).toBeNull();
        const veilStyle = Object.assign({}, ...[veilNode?.props.style].flat().filter(Boolean));
        expect(veilStyle.position).toBe('absolute');
    });
});

describe('SetupSurface accessibility (INV3)', () => {
    it('announces the operation in a live region and the step position on the mark, never a percentage', async () => {
        const screen = await renderScreen(
            <SetupSurface
                run={runState({ events: [progress('setup.thisComputer.configureRelay', 120)] })}
                facts={facts()}
                material="ground"
            />,
        );

        const live = screen.findByTestId('setup-surface:live');
        expect(live?.props.accessibilityLiveRegion).toBe('polite');
        const status = textOf(screen.findByTestId('setup-surface:status'));
        expect(status).toContain('setupSurface.stageConnectStatus');
        expect(status).toContain(RELAY);
        expect(status).not.toMatch(/%|percent/i);

        const mark = screen.findByTestId('setup-surface:mark');
        expect(mark?.props.accessibilityRole).toBe('image');
        expect(mark?.props.accessibilityLabel).toBe(`setupSurface.stepOfTotal:${JSON.stringify({ step: 2, total: SETUP_STAGES.length })}`);
        expect(mark?.props.accessibilityLabel).not.toMatch(/%|percent/i);

        expect(screen.findByTestId('setup-surface:title')?.props.accessibilityRole).toBe('header');
    });

    it('keeps the raw executor text out of the headline and behind Details', async () => {
        const screen = await renderScreen(
            <SetupSurface run={FAILED} facts={facts()} material="ground" onRetry={() => {}} />,
        );

        const status = textOf(screen.findByTestId('setup-surface:status'));
        expect(status).toBe('setupSurface.blockedServiceConflictStatus');
        expect(status).not.toContain('systemd');
        expect(screen.findByTestId('setup-surface:diagnostic')).toBeNull();

        await screen.pressByTestIdAsync('setup-surface:details');
        expect(textOf(screen.findByTestId('setup-surface:diagnostic'))).toBe('systemd user bus unavailable');
    });

    it('renders the changing sentence through the app text primitive, so in-app font scaling reaches it', async () => {
        const screen = await renderScreen(
            <SetupSurface
                run={runState({ events: [progress('setup.thisComputer.configureRelay', 120)] })}
                facts={facts()}
                material="ground"
            />,
        );

        // The title already scales; the sentence must come out of the same primitive rather than a
        // bare animated text node, which bypasses `uiFontScale` entirely.
        expect(screen.findByTestId('setup-surface:status')?.type)
            .toBe(screen.findByTestId('setup-surface:title')?.type);
    });

    it('never opens a Details card that reports "Done" under "Setup stopped"', async () => {
        // A proof failure names itself and carries no diagnostic: the run behind it SUCCEEDED, so
        // the generic card would say the task is done while the headline says setup stopped.
        const screen = await renderScreen(
            <SetupSurface
                run={SUCCEEDED}
                facts={facts({ verification: 'machine_unreachable' })}
                material="ground"
                onRetry={() => {}}
            />,
        );

        expect(screen.findByTestId('setup-surface:blocked')).not.toBeNull();
        expect(screen.findByTestId('setup-surface:details')).toBeNull();
        expect(screen.findByTestId('system-task-progress-card')).toBeNull();
    });

    it('offers Details for a failure that never produced a run, using its own diagnostic', async () => {
        const screen = await renderScreen(
            <SetupSurface
                run={null}
                facts={facts({ startFailure: { code: 'cli_below_setup_floor', message: 'newest on stable is 0.2.12' } })}
                material="ground"
                onRetry={() => {}}
            />,
        );

        expect(textOf(screen.findByTestId('setup-surface:status'))).toBe('setupSurface.blockedCliOutdatedStatus');
        await screen.pressByTestIdAsync('setup-surface:details');
        expect(textOf(screen.findByTestId('setup-surface:diagnostic'))).toBe('newest on stable is 0.2.12');
    });
});

describe('SetupSurface layout and focus (accessibility)', () => {
    it('scrolls, so a compact window or 200% text never hides the recovery action', async () => {
        const screen = await renderScreen(
            <SetupSurface run={FAILED} facts={facts()} material="ground" onRetry={() => {}} />,
        );

        const scroller = screen.findByTestId('setup-surface:blocked');
        expect(scroller).not.toBeNull();
        // The phase node IS the scroller: the composition has no non-scrolling centred wrapper that
        // could clip its own overflow.
        const content = Object.assign({}, ...[scroller?.props.contentContainerStyle].flat().filter(Boolean));
        expect(content.flexGrow).toBe(1);
        expect(content.flex).toBeUndefined();
        expect(content.justifyContent).toBeUndefined();

        const column = screen.root.findAll((node) => {
            const style = Object.assign({}, ...[node.props.style].flat().filter(Boolean));
            return style.maxWidth === 420;
        })[0];
        const columnStyle = Object.assign({}, ...[column?.props.style].flat().filter(Boolean));
        // The stage block is anchored from the top, so opening Details or growing the blocked
        // stack can only push content DOWN into the scroll area — the mark never re-centres.
        expect(columnStyle.marginVertical).toBeUndefined();
        expect(typeof content.paddingTop).toBe('number');
        expect(content.paddingTop).toBeGreaterThan(0);
    });


    it('moves focus to the first recovery action once, and not again while the state holds', async () => {
        const { focused, createNodeMock } = focusTrackingNodeMocks();
        const screen = await renderScreen(
            <SetupSurface run={FAILED} facts={facts()} material="ground" onRetry={() => {}} />,
            { createNodeMock },
        );

        expect(focused).toEqual(['setup-surface:retry']);

        // Opening Details re-renders the blocked surface. Focus must stay where the reader put it
        // rather than being snatched back to Retry on every render of the same state.
        await screen.pressByTestIdAsync('setup-surface:details');
        expect(focused).toEqual(['setup-surface:retry']);

        await act(async () => {
            screen.tree.update(
                <SetupSurface run={FAILED} facts={facts()} material="ground" onRetry={() => {}} />,
            );
        });
        expect(focused).toEqual(['setup-surface:retry']);
    });

    it('moves focus to Details when the blocked state offers no retry', async () => {
        const { focused, createNodeMock } = focusTrackingNodeMocks();
        await renderScreen(
            <SetupSurface run={FAILED} facts={facts()} material="ground" />,
            { createNodeMock },
        );
        expect(focused).toEqual(['setup-surface:details']);
    });

    it('does not move focus while setup is merely working', async () => {
        const { focused, createNodeMock } = focusTrackingNodeMocks();
        await renderScreen(
            <SetupSurface
                run={runState({ events: [progress('setup.thisComputer.installService', 240)] })}
                facts={facts()}
                material="ground"
                onRetry={() => {}}
            />,
            { createNodeMock },
        );
        expect(focused).toEqual([]);
    });
});

describe('SetupSurface under accessibility preferences', () => {
    async function collectFacts(material: 'ground' | 'veil') {
        const screen = await renderScreen(
            <SetupSurface
                run={runState({ events: [progress('setup.thisComputer.installService', 240)] })}
                facts={facts()}
                material={material}
            />,
        );
        const arc = screen.findByTestId('setup-surface:mark:arc');
        return {
            title: textOf(screen.findByTestId('setup-surface:title')),
            status: textOf(screen.findByTestId('setup-surface:status')),
            markLabel: screen.findByTestId('setup-surface:mark')?.props.accessibilityLabel,
            arcOffset: arc?.props.strokeDashoffset,
            highlightPresent: screen.findByTestId('setup-surface:mark:highlight') != null,
            phaseNode: screen.findByTestId('setup-surface:working') != null,
        };
    }

    it('preserves every fact under reduced motion and only removes the travelling highlight', async () => {
        const full = await collectFacts('ground');
        reducedMotionState.enabled = true;
        const reduced = await collectFacts('ground');

        expect(full.highlightPresent).toBe(true);
        expect(reduced.highlightPresent).toBe(false);
        expect(reduced.title).toBe(full.title);
        expect(reduced.status).toBe(full.status);
        expect(reduced.markLabel).toBe(full.markLabel);
        expect(reduced.arcOffset).toBe(full.arcOffset);
        expect(reduced.phaseNode).toBe(true);
    });

    it('preserves every fact under reduce transparency on the veil, which turns solid', async () => {
        const translucent = await collectFacts('veil');
        reduceTransparencyState.enabled = true;
        const solid = await collectFacts('veil');

        expect(solid.title).toBe(translucent.title);
        expect(solid.status).toBe(translucent.status);
        expect(solid.markLabel).toBe(translucent.markLabel);
        expect(solid.arcOffset).toBe(translucent.arcOffset);
        expect(solid.highlightPresent).toBe(true);
    });

    it('re-announces the status sentence when the stage changes', async () => {
        const first = runState({ events: [progress('setup.thisComputer.configureRelay', 120)] });
        const screen = await renderScreen(<SetupSurface run={first} facts={facts()} material="ground" />);
        expect(textOf(screen.findByTestId('setup-surface:status'))).toContain('stageConnectStatus');

        reducedMotionState.enabled = true;
        await act(async () => {
            screen.tree.update(
                <SetupSurface
                    run={runState({ events: [...first.events, progress('setup.thisComputer.installService', 240)] })}
                    facts={facts()}
                    material="ground"
                />,
            );
        });
        expect(textOf(screen.findByTestId('setup-surface:status'))).toContain('stageServiceStatus');
    });
});

describe('SetupSurface departure (reveal)', () => {
    it('hands usability back immediately and reports the end of its one exit beat', async () => {
        const onExited = vi.fn();
        const screen = await renderScreen(
            <SetupSurface run={SUCCEEDED} facts={facts()} material="ground" exiting onExited={onExited} />,
        );

        // The shell underneath is live from the first frame of the departure: the beat is the
        // surface leaving, never a delay in front of the app.
        expect(screen.findByTestId('setup-surface:ground')?.props.pointerEvents).toBe('none');
        expect(onExited).not.toHaveBeenCalled();

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, SETUP_SURFACE_EXIT_MS + 40));
        });
        expect(onExited).toHaveBeenCalledTimes(1);
    });

    it('leaves at once under reduced motion', async () => {
        reducedMotionState.enabled = true;
        const onExited = vi.fn();
        await renderScreen(
            <SetupSurface run={SUCCEEDED} facts={facts()} material="ground" exiting onExited={onExited} />,
        );

        expect(onExited).toHaveBeenCalledTimes(1);
    });

    it('stays put while it is not leaving', async () => {
        const onExited = vi.fn();
        const screen = await renderScreen(
            <SetupSurface run={SUCCEEDED} facts={facts()} material="ground" onExited={onExited} />,
        );

        expect(screen.findByTestId('setup-surface:ground')?.props.pointerEvents).not.toBe('none');
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, SETUP_SURFACE_EXIT_MS + 40));
        });
        expect(onExited).not.toHaveBeenCalled();
    });
    it('comes back from an interrupted departure instead of staying invisible', async () => {
        const onExited = vi.fn();
        const screen = await renderScreen(
            <SetupSurface run={SUCCEEDED} facts={facts()} material="ground" exiting onExited={onExited} />,
        );

        // The facts flipped back mid-beat — maintenance is needed again. The surface must return
        // from wherever the departure got to, and must not report an exit that never happened.
        await act(async () => {
            screen.tree.update(
                <SetupSurface run={SUCCEEDED} facts={facts()} material="ground" onExited={onExited} />,
            );
        });
        // Reanimated drives the real surface from the UI thread; under the node stub the style is
        // resolved at render time, so one more commit is what makes the restored value observable.
        await act(async () => {
            screen.tree.update(
                <SetupSurface run={SUCCEEDED} facts={facts()} material="ground" onExited={onExited} />,
            );
        });

        const ground = screen.findByTestId('setup-surface:ground');
        const style = Object.assign({}, ...[ground?.props.style].flat().filter(Boolean));
        expect(style.opacity).toBe(1);
        expect(ground?.props.pointerEvents).not.toBe('none');

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, SETUP_SURFACE_EXIT_MS + 40));
        });
        expect(onExited).not.toHaveBeenCalled();
    });
});
