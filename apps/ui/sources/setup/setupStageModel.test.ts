import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskEvent } from '@happier-dev/protocol';

import type { SystemTaskRunState } from '@/components/systemTasks/types';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import {
    SETUP_STAGES,
    deriveSetupStageModel,
    type SetupLocalFacts,
} from './setupStageModel';

const RELAY = 'relay.example.test';

function facts(overrides: Partial<SetupLocalFacts> = {}): SetupLocalFacts {
    return {
        relayDisplayName: RELAY,
        entry: 'setup',
        startFailure: null,
        ...overrides,
    };
}

function progress(stepId: string, tsMs: number): SystemTaskEvent {
    return {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        taskId: 'task_1',
        tsMs,
        type: 'progress',
        stepId,
        message: `m:${stepId}`,
    };
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

const FRACTION_STEPS = SETUP_STAGES.map((_, index) => index / SETUP_STAGES.length);

describe('deriveSetupStageModel (INV3 — milestone-quantised)', () => {
    it('advances the fraction only when a later stage is first observed, never within a stage', () => {
        const withinPrepare = deriveSetupStageModel(runState({
            events: [progress('setup.thisComputer.ensureCli', 30)],
        }), facts());
        const stillWithinPrepare = deriveSetupStageModel(runState({
            events: [
                progress('setup.thisComputer.ensureCli', 30),
                progress('setup.thisComputer.inspectService', 60),
                progress('setup.thisComputer.serviceConsent', 90),
            ],
        }), facts());
        const intoConnect = deriveSetupStageModel(runState({
            events: [
                progress('setup.thisComputer.ensureCli', 30),
                progress('setup.thisComputer.inspectService', 60),
                progress('setup.thisComputer.configureRelay', 120),
            ],
        }), facts());

        expect(withinPrepare.completedFraction).toBe(0);
        expect(stillWithinPrepare.completedFraction).toBe(0);
        expect(intoConnect.completedFraction).toBe(1 / SETUP_STAGES.length);
        expect(intoConnect.currentIndex).toBe(1);
    });

    it('only ever yields one of the milestone fractions', () => {
        const sequences: string[][] = [
            [],
            ['setup.thisComputer.ensureCli'],
            ['setup.thisComputer.ensureCli', 'setup.thisComputer.checkAuth'],
            ['setup.thisComputer.checkAuth', 'setup.thisComputer.auth.request', 'setup.thisComputer.auth.wait'],
            ['setup.thisComputer.installService', 'setup.thisComputer.startService'],
            ['setup.thisComputer.restartService'],
            ['setup.thisComputer.somethingNew'],
        ];
        for (const stepIds of sequences) {
            const model = deriveSetupStageModel(runState({
                events: stepIds.map((stepId, index) => progress(stepId, (index + 1) * 10)),
            }), facts());
            expect(FRACTION_STEPS).toContain(model.completedFraction);
            expect(model.completedFraction).toBeLessThan(1);
        }
    });

    it('never moves backwards when an earlier-stage step arrives after a later one', () => {
        const model = deriveSetupStageModel(runState({
            events: [
                progress('setup.thisComputer.installService', 240),
                progress('setup.thisComputer.checkAuth', 250),
            ],
        }), facts());
        expect(model.currentIndex).toBe(SETUP_STAGES.indexOf('service'));
    });

    it('places the PATH step in the service stage and never lets it move the ring back', () => {
        // PATH is ancillary (R6): its failure report arrives late in the run, after the service
        // work, and it must neither look like a new stage nor undo one the executor reached.
        expect(deriveSetupStageModel(runState({
            events: [progress('setup.thisComputer.pathExposure', 300)],
        }), facts()).currentIndex).toBe(SETUP_STAGES.indexOf('service'));

        expect(deriveSetupStageModel(runState({
            events: [
                progress('setup.thisComputer.installService', 240),
                progress('setup.thisComputer.pathExposure', 300),
            ],
        }), facts()).currentIndex).toBe(SETUP_STAGES.indexOf('service'));
    });

    it('shows no progress before a real task event, whatever the ambient inspection found', () => {
        // The ambient inspection resolving is not a setup milestone: `prepare` also covers service
        // inspection and consent, and the inspection may have resolved an override CLI the
        // executor will refuse. Only the executor's own events may move the ring.
        const noRun = deriveSetupStageModel(null, facts());
        const startedRun = deriveSetupStageModel(runState({ events: [] }), facts());

        expect(noRun.currentIndex).toBe(0);
        expect(noRun.completedFraction).toBe(0);
        expect(startedRun.currentIndex).toBe(0);
        expect(startedRun.completedFraction).toBe(0);
    });

    it('opens the verify stage on the executor result and never claims completion', () => {
        const succeededRun = runState({
            status: 'succeeded',
            events: [progress('setup.thisComputer.startService', 240)],
            result: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', ok: true, data: { machineId: 'm' } },
        });
        const starting = deriveSetupStageModel(runState({
            events: [progress('setup.thisComputer.startService', 240)],
        }), facts());
        const succeeded = deriveSetupStageModel(succeededRun, facts());

        expect(starting.currentIndex).toBe(SETUP_STAGES.indexOf('service'));
        expect(starting.completedFraction).toBe(SETUP_STAGES.indexOf('service') / SETUP_STAGES.length);
        // Task success is never "ready": it is the verify stage in progress. The host reveals the
        // shell the moment readiness is proven, so the surface has no success state to reach.
        expect(succeeded.phase).toBe('working');
        expect(succeeded.currentIndex).toBe(SETUP_STAGES.indexOf('verify'));
        expect(succeeded.completedFraction).toBe((SETUP_STAGES.length - 1) / SETUP_STAGES.length);
        expect(succeeded.statusSentence).toEqual({ key: 'setupSurface.stageVerifyStatus', params: { relay: RELAY } });
    });

    it('fails closed with an honest sentence when the executor finished but the machine does not answer (INV10)', () => {
        const model = deriveSetupStageModel(runState({
            status: 'succeeded',
            events: [progress('setup.thisComputer.startService', 240)],
            result: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', ok: true, data: { machineId: 'm' } },
        }), facts({ verification: 'machine_unreachable' }));

        expect(model.phase).toBe('blocked');
        expect(model.completedFraction).toBeLessThan(1);
        expect(model.blocked).toMatchObject({ code: 'machine_unreachable', canceled: false });
        expect(model.statusSentence).toEqual({ key: 'setupSurface.unreachableStatus', params: { relay: RELAY } });
    });

    it('fails closed with its own sentence when the executor finished but the runtime did not converge (INV8)', () => {
        // The service command succeeded and the machine was never asked anything, because the
        // re-read runtime is not this relay's daemon. Leaving the surface "working" here was a
        // permanent stall with no Retry; the named failure is what makes it recoverable.
        const model = deriveSetupStageModel(runState({
            status: 'succeeded',
            events: [progress('setup.thisComputer.startService', 240)],
            result: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', ok: true, data: { machineId: 'm' } },
        }), facts({ verification: 'runtime_not_converged' }));

        expect(model.phase).toBe('blocked');
        expect(model.blocked).toMatchObject({ code: 'runtime_not_converged', canceled: false });
        expect(model.statusSentence).toEqual({ key: 'setupSurface.notConvergedStatus', params: { relay: RELAY } });
    });

    it('never reports completion from task success while the re-read has not proven readiness', () => {
        const model = deriveSetupStageModel(runState({
            status: 'succeeded',
            events: [],
            result: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', ok: true, data: { machineId: 'm' } },
        }), facts({ verification: 'pending' }));
        expect(model.phase).toBe('working');
        expect(model.completedFraction).toBeLessThan(1);
    });

    it('holds the fraction and speaks calm mapped copy when the task fails, keeping the raw text for details', () => {
        const model = deriveSetupStageModel(runState({
            status: 'failed',
            events: [progress('setup.thisComputer.installService', 240)],
            result: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1',
                ok: false,
                error: { code: 'service_install_blocked', message: 'systemd user bus unavailable' },
            },
        }), facts());

        expect(model.phase).toBe('blocked');
        // The raw executor text stays reachable as a diagnostic, never as the headline.
        expect(model.blocked).toEqual({ code: 'service_install_blocked', message: 'systemd user bus unavailable', canceled: false });
        expect(model.completedFraction).toBe(SETUP_STAGES.indexOf('service') / SETUP_STAGES.length);
        expect(model.statusSentence).toBe('setupSurface.blockedServiceConflictStatus');
    });

    it('falls back to the calm generic sentence for a code it does not know', () => {
        const model = deriveSetupStageModel(runState({
            status: 'failed',
            events: [],
            result: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1',
                ok: false,
                error: { code: 'something_new_from_the_executor', message: 'ENOENT: /usr/lib/systemd not found' },
            },
        }), facts());

        expect(model.statusSentence).toBe('setupSurface.blockedStatusFallback');
        expect(model.blocked?.message).toBe('ENOENT: /usr/lib/systemd not found');
    });

    it('maps every executor failure code the setup corridor can raise', () => {
        const mapped: Readonly<Record<string, string>> = {
            service_install_blocked: 'setupSurface.blockedServiceConflictStatus',
            service_consent_declined: 'setupSurface.blockedConsentDeclinedStatus',
            pairing_declined: 'setupSurface.blockedPairingDeclinedStatus',
            machine_id_unavailable: 'setupSurface.blockedPairingIncompleteStatus',
            cli_below_setup_floor: 'setupSurface.blockedCliOutdatedStatus',
            cli_override_below_setup_floor: 'setupSurface.blockedCliOutdatedStatus',
            cli_command_timeout: 'setupSurface.blockedCliUnresponsiveStatus',
            cli_spawn_failed: 'setupSurface.blockedCliUnavailableStatus',
            first_party_component_install_failed: 'setupSurface.blockedCliUnavailableStatus',
            system_task_start_failed: 'setupSurface.blockedCliUnavailableStatus',
            cli_command_failed: 'setupSurface.blockedCliFailedStatus',
            invalid_cli_response: 'setupSurface.blockedCliFailedStatus',
            invalid_status_result: 'setupSurface.blockedCliFailedStatus',
        };
        for (const [code, key] of Object.entries(mapped)) {
            const model = deriveSetupStageModel(null, facts({ startFailure: { code, message: 'raw diagnostic text' } }));
            expect(model.statusSentence).toBe(key);
            expect(JSON.stringify(model.statusSentence)).not.toContain('raw diagnostic');
        }
    });

    it('treats a start failure as blocked before any task exists', () => {
        const model = deriveSetupStageModel(null, facts({
            startFailure: { code: 'system_task_start_failed', message: 'hsetup is missing' },
        }));
        expect(model.phase).toBe('blocked');
        expect(model.blocked).toEqual({ code: 'system_task_start_failed', message: 'hsetup is missing', canceled: false });
    });

    it('is the checking phase when no task exists and the entry context is checking', () => {
        const model = deriveSetupStageModel(null, facts({ entry: 'checking' }));
        expect(model.phase).toBe('checking');
        expect(model.completedFraction).toBe(0);
        expect(model.title).toBe('setupSurface.checkingTitle');
    });
});

describe('deriveSetupStageModel copy and announcements', () => {
    it('names the real relay in the connect and verify sentences', () => {
        const connect = deriveSetupStageModel(runState({
            events: [progress('setup.thisComputer.configureRelay', 120)],
        }), facts());
        const verify = deriveSetupStageModel(runState({
            status: 'succeeded',
            events: [progress('setup.thisComputer.startService', 240)],
            result: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', ok: true, data: { machineId: 'm' } },
        }), facts());

        expect(connect.statusSentence).toEqual({ key: 'setupSurface.stageConnectStatus', params: { relay: RELAY } });
        expect(verify.statusSentence).toEqual({ key: 'setupSurface.stageVerifyStatus', params: { relay: RELAY } });
    });

    it('announces the step position, never a percentage', () => {
        for (const stepId of ['setup.thisComputer.ensureCli', 'setup.thisComputer.configureRelay', 'setup.thisComputer.installService', 'setup.thisComputer.restartService']) {
            const model = deriveSetupStageModel(runState({ events: [progress(stepId, 10)] }), facts());
            expect(model.stepAnnouncement).toEqual({
                key: 'setupSurface.stepOfTotal',
                params: { step: model.currentIndex + 1, total: SETUP_STAGES.length },
            });
            expect(JSON.stringify(model.stepAnnouncement)).not.toMatch(/%|percent/i);
        }
    });
});
