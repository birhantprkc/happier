import { CLI_ACQUISITION_PROGRESS_EVENT, parseCliAcquisitionProgress, readCliAcquisitionFailurePhase, type CliAcquisitionPhase } from '@happier-dev/protocol';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { t, type TranslationKeyNoParams } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';

/**
 * The ONE setup-stage derivation (plan INV3 / INV6 / D10).
 *
 * Pure: `(run state | null, local facts) → what the surface shows`. Nothing here reads a clock, a
 * store or the preference system, and the generic primitives it feeds (`CapacityRing`,
 * `StatusTransition`, `SystemTaskProgressCard`) learn nothing about setup from it — they receive a
 * fraction, a key and a run state respectively.
 *
 * Progress is quantised to milestones and comes from the executor's OWN events only. A stage is
 * complete when a step of a LATER stage has been observed; the executor's success opens the verify
 * stage, and the app reveals the shell the moment its re-read proves readiness — so this model has
 * no success state and its fraction never reaches 1. It takes one of four values and never creeps.
 * `DESIGN.md` names optimistic UI that hides uncertainty as a failure mode; a ring pre-filled by an
 * ambient read that proved nothing about setup is exactly that.
 */

export const SETUP_STAGES = ['prepare', 'connect', 'service', 'verify'] as const;

export type SetupStageId = (typeof SETUP_STAGES)[number];

export type SetupSurfacePhase = 'checking' | 'working' | 'blocked';

export type SetupLocalFacts = Readonly<{
    /** The relay the app selected, formatted for display. Present tense copy names it verbatim. */
    relayDisplayName: string;
    /** R14: post-auth unresolved facts read as "checking"; a started or failed run reads as setup. */
    entry: 'checking' | 'setup';
    /**
     * The run never began, or the ambient inspection failed. The code chooses the calm sentence;
     * the message is the raw diagnostic, which belongs behind Details and never in the headline.
     */
    startFailure?: SetupStartFailure | null;
    /**
     * The gate's readiness proof (INV8/INV10). Both failures are honest endings to a run that
     * already finished: `runtime_not_converged` — the re-read runtime does not describe this
     * relay's daemon — and `machine_unreachable` — it does, but the relay cannot reach it. There
     * is no `verified` value: the host reveals the shell the moment readiness is proven, so the
     * surface is gone by then.
     */
    verification?: 'pending' | 'runtime_not_converged' | 'machine_unreachable';
}>;

export type SetupStartFailure = Readonly<{ code: string; message: string | null }>;

export type SetupBlockedFacts = Readonly<{
    code: string;
    /** The executor's own words. Diagnostic only — the surface shows it behind Details. */
    message: string | null;
    canceled: boolean;
}>;

export type SetupStageModel = Readonly<{
    phase: SetupSurfacePhase;
    stages: readonly SetupStageId[];
    /** Index of the stage in progress. */
    currentIndex: number;
    /** `completedStages / stages.length` — one of four values, never interpolated. */
    completedFraction: number;
    blocked: SetupBlockedFacts | null;
    title: string;
    statusSentence: string;
    /** Transfer bytes only; separate from phase announcements and the milestone ring. */
    downloadProgress?: string;
    /** "Step N of M" for assistive tech. Never a percentage. */
    stepAnnouncement: string;
}>;

/**
 * Executor step id → stage. Unknown ids keep the stage already reached (they can never move it
 * back), so a new step lands in the right place once it is added here and is harmless before.
 */
const STEP_STAGE: Readonly<Record<string, SetupStageId>> = {
    'setup.thisComputer.ensureCli': 'prepare',
    'setup.thisComputer.inspectService': 'prepare',
    'setup.thisComputer.serviceConsent': 'prepare',
    'setup.thisComputer.configureRelay': 'connect',
    'setup.thisComputer.checkAuth': 'connect',
    'setup.thisComputer.auth.request': 'connect',
    'setup.thisComputer.auth.wait': 'connect',
    'setup.thisComputer.installService': 'service',
    'setup.thisComputer.startService': 'service',
    'setup.thisComputer.restartService': 'service',
    // PATH exposure is ancillary and reported late (R6): it belongs to the service stage it runs
    // beside, and because the reached stage only ever moves forward it can never pull the ring back
    // from `verify`.
    'setup.thisComputer.pathExposure': 'service',
};

const STAGE_STATUS_KEY = {
    prepare: 'setupSurface.stagePrepareStatus',
    connect: 'setupSurface.stageConnectStatus',
    service: 'setupSurface.stageServiceStatus',
    verify: 'setupSurface.stageVerifyStatus',
} as const satisfies Record<SetupStageId, string>;

const ACQUISITION_STATUS_KEY = {
    resolvingRelease: 'setupSurface.acquisitionResolvingReleaseStatus',
    downloading: 'setupSurface.acquisitionDownloadingStatus',
    verifying: 'setupSurface.acquisitionVerifyingStatus',
    unpacking: 'setupSurface.acquisitionUnpackingStatus',
    installing: 'setupSurface.acquisitionInstallingStatus',
    finalizing: 'setupSurface.acquisitionFinalizingStatus',
    checkingCli: 'setupSurface.acquisitionCheckingCliStatus',
    checkingDaemon: 'setupSurface.acquisitionCheckingDaemonStatus',
} as const satisfies Record<CliAcquisitionPhase, TranslationKeyNoParams>;

const ACQUISITION_FAILURE_KEY = {
    resolvingRelease: 'setupSurface.acquisitionReleaseFailed',
    downloading: 'setupSurface.acquisitionDownloadFailed',
    verifying: 'setupSurface.acquisitionVerificationFailed',
    unpacking: 'setupSurface.acquisitionInstallFailed',
    installing: 'setupSurface.acquisitionInstallFailed',
    finalizing: 'setupSurface.acquisitionInstallFailed',
    checkingCli: 'setupSurface.blockedCliUnavailableStatus',
    checkingDaemon: 'setupSurface.blockedCliFailedStatus',
} as const satisfies Record<CliAcquisitionPhase, TranslationKeyNoParams>;

/**
 * Failure code → the sentence the person reads.
 *
 * The executor's own message names systemd units, ring versions and file paths: true, useful to a
 * developer, and the wrong thing to put in the one sentence a first-run surface gets. The code is
 * the stable contract, so it picks localized copy that says what happened and what is safe; the
 * raw message stays reachable behind Details. An unmapped code takes the generic sentence rather
 * than leaking whatever the process printed.
 */
const BLOCKED_STATUS_KEY: Readonly<Record<string, TranslationKeyNoParams>> = {
    service_install_blocked: 'setupSurface.blockedServiceConflictStatus',
    service_consent_declined: 'setupSurface.blockedConsentDeclinedStatus',
    pairing_declined: 'setupSurface.blockedPairingDeclinedStatus',
    machine_id_unavailable: 'setupSurface.blockedPairingIncompleteStatus',
    cli_below_setup_floor: 'setupSurface.blockedCliOutdatedStatus',
    cli_override_below_setup_floor: 'setupSurface.blockedCliOutdatedStatus',
    cli_command_timeout: 'setupSurface.blockedCliUnresponsiveStatus',
    cli_spawn_failed: 'setupSurface.blockedCliUnavailableStatus',
    first_party_component_install_failed: 'setupSurface.acquisitionInstallFailed',
    system_task_start_failed: 'setupSurface.blockedCliUnavailableStatus',
    cli_command_failed: 'setupSurface.blockedCliFailedStatus',
    invalid_cli_response: 'setupSurface.blockedCliFailedStatus',
    invalid_status_result: 'setupSurface.blockedCliFailedStatus',
};

function resolveReachedIndex(run: SystemTaskRunState | null): number {
    let reached = 0;
    if (!run) return reached;
    for (const event of run.events) {
        const stage = event.stepId ? STEP_STAGE[event.stepId] : undefined;
        if (!stage) continue;
        reached = Math.max(reached, SETUP_STAGES.indexOf(stage));
    }
    return reached;
}

function resolveBlocked(run: SystemTaskRunState | null, facts: SetupLocalFacts): SetupBlockedFacts | null {
    if (facts.startFailure) {
        return { ...facts.startFailure, canceled: false };
    }
    if (!run?.result || run.result.ok) return null;
    const canceled = run.status === 'canceled';
    return {
        code: run.result.error.code,
        message: run.result.error.message.trim() || null,
        canceled,
    };
}

function blockedStatus(code: string): string {
    const phase = readCliAcquisitionFailurePhase(code);
    if (phase) return t(ACQUISITION_FAILURE_KEY[phase]);
    return t(BLOCKED_STATUS_KEY[code] ?? 'setupSurface.blockedStatusFallback');
}

function stageStatus(stage: SetupStageId, relay: string): string {
    switch (stage) {
        case 'prepare':
            return t(STAGE_STATUS_KEY.prepare);
        case 'connect':
            return t(STAGE_STATUS_KEY.connect, { relay });
        case 'service':
            return t(STAGE_STATUS_KEY.service);
        case 'verify':
            return t(STAGE_STATUS_KEY.verify, { relay });
    }
}

export function deriveSetupStageModel(run: SystemTaskRunState | null, facts: SetupLocalFacts): SetupStageModel {
    const total = SETUP_STAGES.length;
    const blocked = resolveBlocked(run, facts);
    const succeeded = facts.entry === 'setup' && run?.result?.ok === true;
    // The executor's success opens the last stage; the host's own re-read closes the surface.
    const currentIndex = succeeded ? total - 1 : resolveReachedIndex(run);
    const completedFraction = currentIndex / total;
    const stepAnnouncement = t('setupSurface.stepOfTotal', { step: currentIndex + 1, total });
    const relay = facts.relayDisplayName;

    if (blocked) {
        return {
            phase: 'blocked',
            stages: SETUP_STAGES,
            currentIndex,
            completedFraction,
            blocked,
            title: blocked.canceled ? t('setupSurface.canceledTitle') : t('setupSurface.blockedTitle'),
            statusSentence: blocked.canceled ? t('setupSurface.canceledStatus') : blockedStatus(blocked.code),
            stepAnnouncement,
        };
    }

    if (facts.verification === 'machine_unreachable' || facts.verification === 'runtime_not_converged') {
        return {
            phase: 'blocked',
            stages: SETUP_STAGES,
            currentIndex,
            completedFraction,
            blocked: { code: facts.verification, message: null, canceled: false },
            title: t('setupSurface.blockedTitle'),
            statusSentence: facts.verification === 'machine_unreachable'
                ? t('setupSurface.unreachableStatus', { relay })
                : t('setupSurface.notConvergedStatus', { relay }),
            stepAnnouncement,
        };
    }

    // Inspection can acquire the CLI, but its result establishes no completed setup stage.
    const latest = run?.events.at(-1);
    const acquisition = !run?.result && latest?.type === CLI_ACQUISITION_PROGRESS_EVENT
        ? parseCliAcquisitionProgress(latest.data) : null;
    const downloadProgress = acquisition?.phase === 'downloading' && acquisition.receivedBytes !== undefined
        ? (acquisition.totalBytes !== undefined
            ? t('setupSurface.acquisitionDownloadBytesTotal', { received: formatByteSize(acquisition.receivedBytes), total: formatByteSize(acquisition.totalBytes) })
            : t('setupSurface.acquisitionDownloadBytes', { received: formatByteSize(acquisition.receivedBytes) }))
        : undefined;
    if (facts.entry === 'checking') {
        return {
            phase: 'checking',
            stages: SETUP_STAGES,
            currentIndex,
            completedFraction,
            blocked: null,
            title: t('setupSurface.checkingTitle'),
            statusSentence: acquisition ? t(ACQUISITION_STATUS_KEY[acquisition.phase]) : t('setupSurface.checkingStatus', { relay }),
            downloadProgress,
            stepAnnouncement,
        };
    }

    return {
        phase: 'working',
        stages: SETUP_STAGES,
        currentIndex,
        completedFraction,
        blocked: null,
        title: t('setupSurface.workingTitle'),
        statusSentence: acquisition && currentIndex === 0 ? t(ACQUISITION_STATUS_KEY[acquisition.phase]) : stageStatus(SETUP_STAGES[currentIndex] ?? 'prepare', relay),
        downloadProgress,
        stepAnnouncement,
    };
}
