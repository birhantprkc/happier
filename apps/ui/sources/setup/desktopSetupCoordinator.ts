import type { SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { buildLocalMachineSetupSystemTaskSpec, type LocalMachineSetupTarget } from '@/components/systemTasks/buildLocalMachineSetupSystemTaskSpec';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/settings/machines/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { awaitSystemTaskResult } from '@/components/systemTasks/awaitSystemTaskResult';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveWebappUrlFromServerUrl } from '@/sync/domains/server/url/resolveWebappUrlFromServerUrl';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/currentAppVariant';

import { toRelayHostDisplay } from '@/sync/domains/server/url/serverUrlDisplay';

import {
    readAlwaysMoveDefaultFollowingService,
    readKeptBackgroundService,
    rememberAlwaysMoveDefaultFollowingService,
    rememberKeptBackgroundService,
} from './desktopRelayMovePreference';
import {
    daemonRelayMatchesExpectation,
    desktopLocalRuntimeConverged,
    type DesktopCliChannel,
    type DesktopCliChoiceFacts,
    type DesktopCliUpdateFacts,
    type DesktopLocalInspection,
    type DesktopLocalReadinessFacts,
    type DesktopSetupExpectation,
} from './deriveDesktopLocalSetupSnapshot';
import type { RelayReconciliationConsentAnswer, ThisComputerMoveRequest } from './presentRelayReconciliationConsent';
import {
    identifyKeptBackgroundService,
    keptBackgroundServiceApplies,
    resolveRelayReconciliationConsent,
    type RelayReconciliationDecision,
} from './relayReconciliationConsent';
import { resolveAppAccountLabel, resolveDaemonAccountLabel } from './thisComputerLabels';

/**
 * The single desktop-side owner of local setup (plan §3.3).
 *
 * `inspect()` runs ONE ambient inspection per app open — `daemon.service.status.v1`, which
 * acquires/installs the managed CLI and reads what the running daemon is doing. `DesktopLocalSetupWarmup`
 * starts it the moment the desktop app opens, before anyone signs in (R5/INV4); the authenticated
 * gate then awaits that same promise rather than starting a read of its own. It is never
 * aborted and nothing re-runs it when the relay changes in the footer: the UI re-compares the
 * new target against the same immutable facts. A failed inspection is reported, not guessed
 * around, and the next `inspect()` retries it.
 *
 * `startSetup()` and `reconcile()` are the only paths that build the explicit-target executor spec
 * (R3), and the one place this computer's daemon is asked about before it moves (UD5/D1): each
 * awaits an in-flight inspection so two acquisitions never contend (C3), asks the one question the
 * facts call for, then hands the spec to the caller's runner adapter.
 *
 * The only thing it keeps beyond this app open is the person's own answers, through the existing
 * device-local preference owner ("always move", "keep it as is"). No lock, no event bus, no
 * generations, no scheduler.
 */
export type DesktopSetupStartOutcome = Readonly<{
    taskId: string;
}>;

/**
 * Why `verifyCurrentTarget()` could not prove this computer ready. Exactly two ways to fail, both
 * named: the re-read runtime does not describe a converged daemon for this relay and account
 * (INV8), or it does but the machine did not answer the read-only RPC (INV10).
 */
export type DesktopSetupVerificationFailure = 'runtime_not_converged' | 'machine_unreachable';

/**
 * The one verdict. It always settles, and it names the facts it is ABOUT — the same object
 * `readInspectionSnapshot()` publishes, so a caller can tell when its verdict has gone stale
 * because something re-read this computer. Identity is the whole point of returning it: a verdict
 * kept past the facts it answered for is what parked the gate behind an actionless veil.
 */
export type DesktopSetupVerificationOutcome =
    | Readonly<{ status: 'verified'; machineId: string; inspection: DesktopLocalInspection }>
    | Readonly<{ status: 'blocked'; code: DesktopSetupVerificationFailure; inspection: DesktopLocalInspection }>;

/** The relay, account and server profile the app expected when the ambient facts were read. */
export type DesktopSetupObservedExpectation = DesktopSetupExpectation & Readonly<{ serverId: string }>;

export type DesktopSetupCoordinator = Readonly<{
    /**
     * The one ambient inspection. `fresh: true` is only for the post-setup proof (INV8): the
     * executor just changed the runtime, so the app re-reads instead of trusting task success.
     */
    inspect: (options?: Readonly<{ fresh?: boolean }>) => Promise<DesktopLocalInspection>;
    /**
     * F6 — the one observation, observed. Every reader renders `readInspectionSnapshot()` and
     * re-renders when this fires, so a fresh read by ANY caller reaches all of them: previously
     * each consumer awaited the promise once and kept whatever it saw, which is why the tray kept
     * a drift title from app open and the settings row beside a repaired daemon still said it was
     * not running. Fires on both edges of a read — starting and settling — and the snapshot is
     * referentially stable between changes.
     */
    subscribe: (listener: () => void) => () => void;
    /**
     * The last facts this app open actually established. It stays put while a re-read is in
     * flight: a surface already showing true facts about this computer must not flash an empty
     * state while the CLI answers again (`apps/ui/AGENTS.md`). `pending` therefore means only one
     * thing — nothing has ever settled.
     */
    readInspectionSnapshot: () => DesktopLocalInspection;
    /**
     * Whether a read is in flight right now. It is the separate fact a reader needs when being
     * mid-check is itself worth showing — the setup surface acknowledges a Retry press with it —
     * while every other reader keeps rendering the facts above.
     */
    readInspectionRefreshing: () => boolean;
    /** Existing task owner for a surface that needs progress; facts above stay unchanged. */
    readInspectionTaskId: () => string | null;
    /**
     * What the app expected of this computer when the current facts were read — or, when the read
     * was warmed before sign-in, what the first signed-in reader expected of it. UD5 compares the
     * daemon against this, never against installation history (D7). `null` until an inspection
     * is requested.
     */
    readObservedExpectation: () => DesktopSetupObservedExpectation | null;
    /**
     * The ONE proof that this computer is ready for the relay and account the app is on (INV8 +
     * INV10): read the runtime, check convergence against the current target, then ask the
     * machine to answer one read-only `capabilities.describe`. Every surface that would otherwise
     * decide readiness for itself — the automatic gate and the settings setup flow — asks here,
     * because a task result only says a command succeeded: the running daemon can still carry the
     * wrong identity, ownership may not have converged, and the relay may not reach it at all.
     *
     * `fresh: true` re-reads the runtime and is what a caller uses after the executor changed it,
     * or when the user asks to adopt what is already on the computer. Without it the one ambient
     * inspection of this app open is reused, so an already-ready computer proves itself without a
     * second read (D3/C3).
     */
    verifyCurrentTarget: (options?: Readonly<{ fresh?: boolean }>) => Promise<DesktopSetupVerificationOutcome>;
    /**
     * An explicit "set up / connect this computer". The person asked for the move, so a relay move
     * needs no second question — but an ACCOUNT move still asks (D1), because the account the
     * daemon is signed in as loses this computer. Resolves `null` when they chose to keep it.
     */
    startSetup: (params: DesktopSetupStartParams) => Promise<DesktopSetupStartOutcome | null>;
    /**
     * R8/L7 — a **direct** Relay/Home preference change, a relaunch whose daemon is elsewhere, or
     * authentication completing after one. Runs the same preflight and the same idempotent executor
     * as `startSetup`, after UD5/D1 consent — unless this device already chose to keep this daemon
     * as it is (D5). Resolves `null` when the service stays where it is.
     */
    reconcile: (params: DesktopSetupStartParams) => Promise<DesktopSetupStartOutcome | null>;
}>;

export type DesktopSetupStartParams = Readonly<{
    start: (spec: SystemTaskSpec) => Promise<string>;
    /** The one ask. Defaults to the canonical presenter; a test or a headless caller may replace it. */
    confirm?: (request: ThisComputerMoveRequest) => Promise<RelayReconciliationConsentAnswer>;
    /** R12 — Settings › This computer › Command line's change action: ask the one-CLI question again. */
    reconsiderCli?: boolean;
}>;

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean {
    return value === true;
}

function readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * UD5 fails closed on an unproven target mode, so only the two values the CLI actually publishes
 * are accepted. Anything else — a missing field from an older CLI, or output outside that
 * vocabulary — stays UNKNOWN rather than being mapped onto a mode the service may not have.
 */
function readServiceTargetMode(value: unknown): DesktopLocalReadinessFacts['service']['targetMode'] {
    return value === 'default-following' || value === 'pinned' ? value : null;
}

/**
 * Unknown stays unknown here too: a missing field is an older CLI and anything outside the two
 * modes proves nothing. Neither may become `at-login`, which would claim this computer keeps
 * answering after the app closes, nor `on-demand`, which would offer to stop it.
 */
function readServiceAutostartMode(value: unknown): DesktopLocalReadinessFacts['service']['autostart'] {
    return value === 'at-login' || value === 'on-demand' ? value : null;
}

function readCredentialState(value: unknown): DesktopLocalReadinessFacts['auth']['credentialState'] {
    return value === 'missing' || value === 'rejected' || value === 'valid' || value === 'unknown' ? value : null;
}

/** K1 — all four fields or nothing: a partial update answer proves no update. */
function readCliUpdate(value: unknown): DesktopCliUpdateFacts | null {
    const record = readRecord(value);
    const currentVersion = readString(record.currentVersion);
    if (!currentVersion || typeof record.updateAvailable !== 'boolean' || typeof record.managed !== 'boolean') {
        return null;
    }
    return {
        currentVersion,
        latestVersion: readString(record.latestVersion),
        updateAvailable: record.updateAvailable,
        managed: record.managed,
    };
}

/** R12 — unknown stays unknown: an unreadable answer is "nobody was asked, nothing else found". */
function readCliChoice(value: unknown): DesktopCliChoiceFacts {
    const record = readRecord(value);
    const mode = record.mode === 'managed' || record.mode === 'own' ? record.mode : null;
    const other = readRecord(record.otherCli);
    const command = readString(other.command);
    return {
        mode,
        otherCli: command
            ? {
                command,
                origin: other.origin === 'npm' || other.origin === 'brew' ? other.origin : 'unknown',
                removalCommand: readString(other.removalCommand),
                updateCommand: readString(other.updateCommand),
            }
            : null,
    };
}

function readRuntimeConvergence(value: unknown): DesktopLocalReadinessFacts['runtimeConvergence'] {
    const record = readRecord(value);
    const keys = ['controlReachable', 'serviceOwnsRunningDaemon', 'machineIdMatches', 'cliVersionMatches'] as const;
    if (!keys.every((key) => typeof record[key] === 'boolean')) {
        return null;
    }
    return {
        controlReachable: record.controlReachable === true,
        serviceOwnsRunningDaemon: record.serviceOwnsRunningDaemon === true,
        machineIdMatches: record.machineIdMatches === true,
        cliVersionMatches: record.cliVersionMatches === true,
    };
}

function readCliChannel(value: unknown): DesktopCliChannel | null {
    return value === 'stable' || value === 'preview' || value === 'publicdev' ? value : null;
}

/** Projects `daemon.service.status.v1`'s result into the facts the entry policy reads. */
export function readDesktopLocalReadinessFacts(data: unknown): DesktopLocalReadinessFacts | null {
    const record = readRecord(data);
    const acquisition = readRecord(record.acquisition);
    const command = readString(acquisition.command);
    const provenance = acquisition.provenance === 'managed' || acquisition.provenance === 'override' ? acquisition.provenance : null;
    if (!command || !provenance) {
        return null;
    }
    const server = readRecord(record.server);
    const auth = readRecord(record.auth);
    const service = readRecord(record.service);
    return {
        acquisition: { command, provenance, version: readString(acquisition.version), channel: readCliChannel(acquisition.channel) },
        server: {
            serverUrl: readString(server.serverUrl),
            publicServerUrl: readString(server.publicServerUrl),
            localServerUrl: readString(server.localServerUrl),
            comparableKey: readString(server.comparableKey),
        },
        auth: {
            credentialState: readCredentialState(auth.credentialState),
            validatedAccountId: readString(auth.validatedAccountId),
            accountId: readString(auth.accountId),
            accountLabel: readString(auth.accountLabel),
            machineId: readString(auth.machineId),
        },
        service: {
            installed: readBoolean(service.installed),
            running: readBoolean(service.running),
            autostart: readServiceAutostartMode(service.autostart),
            targetMode: readServiceTargetMode(service.targetMode),
        },
        runtimeConvergence: readRuntimeConvergence(record.runtimeConvergence),
        cliUpdate: readCliUpdate(readRecord(record.cli).update),
        cliChoice: readCliChoice(readRecord(record.cli).choice),
    };
}

function inspectionFromResult(result: SystemTaskResult): DesktopLocalInspection {
    if (!result.ok) {
        return { status: 'failed', error: { code: result.error.code, message: result.error.message } };
    }
    const facts = readDesktopLocalReadinessFacts(result.data);
    if (!facts) {
        return { status: 'failed', error: { code: 'invalid_status_result', message: 'The local inspection returned no acquisition facts.' } };
    }
    return { status: 'resolved', facts };
}

/**
 * The explicit target for the executor, read from the app's canonical owners. A missing account
 * or relay throws by name; nothing here consults the CLI's ambient relay (B6).
 */
export function resolveDesktopSetupTarget(): LocalMachineSetupTarget {
    const activeServer = getActiveServerSnapshot();
    const activeRelayUrl = readString(activeServer.serverUrl);
    if (!activeRelayUrl) {
        throw new Error('desktop setup requires the app relay url');
    }
    const accountId = readString(getActiveServerAccountScope()?.accountId);
    if (!accountId) {
        throw new Error('desktop setup requires the signed-in account for the app relay');
    }
    return {
        activeRelayUrl,
        activeWebappUrl: resolveWebappUrlFromServerUrl(activeRelayUrl),
        activeLocalRelayUrl: readString(activeServer.activeLocalRelayUrl),
        expectedAccountId: accountId,
        channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(),
    };
}

function defaultMachineRpc(params: Readonly<{ machineId: string; serverId: string }>): Promise<unknown> {
    return machineRpcWithServerScope<unknown, Record<string, never>>({
        machineId: params.machineId,
        serverId: params.serverId,
        method: RPC_METHODS.CAPABILITIES_DESCRIBE,
        payload: {},
    });
}

const PENDING_INSPECTION: DesktopLocalInspection = { status: 'pending' };

function readCurrentExpectation(): DesktopSetupObservedExpectation {
    const activeServer = getActiveServerSnapshot();
    return {
        serverId: readString(activeServer.serverId) ?? '',
        relayUrl: readString(activeServer.serverUrl) ?? '',
        localRelayUrl: readString(activeServer.activeLocalRelayUrl),
        accountId: readString(getActiveServerAccountScope()?.accountId),
    };
}

/**
 * The move a consent question is about, named from the facts the decision used: hosts for a relay
 * move, both accounts for an account move (U2/D1).
 */
function buildMoveRequest(
    decision: Exclude<RelayReconciliationDecision, 'start'>,
    inspection: DesktopLocalInspection,
    target: DesktopSetupExpectation,
): ThisComputerMoveRequest {
    const facts = inspection.status === 'resolved' ? inspection.facts : null;
    const toRelayHost = toRelayHostDisplay(target.relayUrl);
    const fromRelayHost = facts?.server.serverUrl ? toRelayHostDisplay(facts.server.serverUrl) : null;
    if (decision === 'confirm_relay' || !facts || !target.accountId) {
        return { kind: 'relay', fromRelayHost, toRelayHost };
    }
    return {
        kind: 'account',
        fromAccountLabel: resolveDaemonAccountLabel(facts.auth) ?? '',
        toAccountLabel: resolveAppAccountLabel(target.accountId),
        relayHost: toRelayHost,
        fromRelayHost: daemonRelayMatchesExpectation(facts, target) ? null : fromRelayHost,
    };
}

export function createDesktopSetupCoordinator(deps: Readonly<{
    runner: () => SystemTaskRunner;
    /** INV10's canonical owner. Read-only, so it keeps its production default. */
    machineRpc?: (params: Readonly<{ machineId: string; serverId: string }>) => Promise<unknown>;
    /** The one consent presenter (UD5/D1). */
    confirm?: (request: ThisComputerMoveRequest) => Promise<RelayReconciliationConsentAnswer>;
}>): DesktopSetupCoordinator {
    let inspection: Promise<DesktopLocalInspection> | null = null;
    let observedExpectation: DesktopSetupObservedExpectation | null = null;
    let snapshot: DesktopLocalInspection = PENDING_INSPECTION;
    let refreshing = false;
    let inspectionTaskId: string | null = null;
    const listeners = new Set<() => void>();

    const notify = (): void => {
        for (const listener of Array.from(listeners)) {
            listener();
        }
    };

    const runInspection = async (): Promise<DesktopLocalInspection> => {
        // The facts are read against the app's identity as it is NOW, when the read is requested.
        // Recording it when the read settles instead would hide every server change that lands
        // inside the acquisition window from the relay-change discriminator: a navigation-,
        // notification-, deep-link-, voice- or focus-driven switch would then read as ordinary
        // entry convergence and repoint the daemon (INV7), and a genuine direct selection landing
        // there would skip the UD5 ask.
        observedExpectation = readCurrentExpectation();
        let runner: SystemTaskRunner;
        let taskId: string;
        try {
            runner = deps.runner();
            taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec('daemon.service.status.v1'));
            inspectionTaskId = taskId;
            notify();
        } catch (error) {
            return {
                status: 'failed',
                error: {
                    code: 'system_task_start_failed',
                    message: error instanceof Error ? error.message : 'The local inspection could not start.',
                },
            };
        }
        return inspectionFromResult(await awaitSystemTaskResult(runner, taskId));
    };

    const inspect = (options?: Readonly<{ fresh?: boolean }>): Promise<DesktopLocalInspection> => {
        if (!inspection || options?.fresh) {
            // The facts stand until they are replaced: readers keep the last established ones and
            // learn separately that a read is running.
            refreshing = true;
            inspectionTaskId = null;
            notify();
            inspection = runInspection().then((result) => {
                if (result.status === 'failed') {
                    inspection = null;
                }
                refreshing = false;
                snapshot = result;
                notify();
                return result;
            });
            return inspection;
        }
        if (observedExpectation !== null && observedExpectation.accountId === null) {
            // R5/INV4 — the pre-auth warm-up starts this read at app open, before the user has
            // chosen where to sign in. An observation made then expected NOTHING of this
            // computer, so it cannot tell a relay CHANGE from the user simply picking their relay
            // in the welcome footer: treating it as a change would classify first-run entry as
            // L7 reconciliation and, with no direct Relay/Home preference written yet, suppress
            // setup altogether (R2). The first reader that has an account is the first one with
            // an expectation, so the expectation is recorded here, for it. Every later change is
            // still measured against that identity (INV7), exactly as before the warm-up existed.
            observedExpectation = readCurrentExpectation();
        }
        return inspection;
    };

    const verifyCurrentTarget: DesktopSetupCoordinator['verifyCurrentTarget'] = async (options) => {
        // The target is read now, the way `runInspection` reads it, so the verdict belongs to the
        // identity the app is on at the moment the proof was asked for.
        const expected = readCurrentExpectation();
        const inspection = await inspect(options?.fresh ? { fresh: true } : undefined);
        const machineId = inspection.status === 'resolved' && desktopLocalRuntimeConverged(inspection, expected)
            ? inspection.facts.auth.machineId
            : null;
        if (!machineId) {
            return { status: 'blocked', code: 'runtime_not_converged', inspection };
        }
        try {
            // INV10 — convergence describes the daemon this computer runs; it cannot say whether
            // the relay can reach it. The canonical owner bounds its own wait, so nothing here
            // adds a timeout, a retry or a poll.
            await (deps.machineRpc ?? defaultMachineRpc)({ machineId, serverId: expected.serverId });
        } catch {
            return { status: 'blocked', code: 'machine_unreachable', inspection };
        }
        return { status: 'verified', machineId, inspection };
    };

    /**
     * Asks the one question the decision named and records the answer. `true` means go ahead.
     * "Keep it as is" is remembered for exactly the daemon it was said about (D5); "always" is a
     * relay answer and is never offered for an account move.
     */
    const askToMove = async (
        decision: Exclude<RelayReconciliationDecision, 'start'>,
        ambient: DesktopLocalInspection,
        target: DesktopSetupExpectation,
        confirm: DesktopSetupStartParams['confirm'],
    ): Promise<boolean> => {
        // The presenter is loaded when a question is actually asked: the modal stack is not
        // something the ambient read, or any coordinator reader, should pay for.
        const ask = confirm ?? deps.confirm ?? (await import('./presentRelayReconciliationConsent')).presentRelayReconciliationConsent;
        const answer = await ask(buildMoveRequest(decision, ambient, target));
        if (answer === 'keep') {
            const kept = identifyKeptBackgroundService(ambient);
            if (kept) rememberKeptBackgroundService(kept);
            return false;
        }
        if (answer === 'always' && decision === 'confirm_relay') {
            rememberAlwaysMoveDefaultFollowingService();
        }
        return true;
    };

    const readAmbient = async (): Promise<DesktopLocalInspection> => {
        // Awaiting an in-flight ambient read keeps two adjacent acquisitions from contending (C3).
        // A failed or rejected inspection must not block setup or repair: it decides nothing.
        const settled = inspection ? await inspection.catch(() => null) : null;
        if (settled && settled.status === 'resolved' && settled.facts.auth.credentialState !== 'unknown') {
            return settled;
        }
        // D1 is decided on facts that could see the daemon's account. Facts read while the relay
        // was unreachable — or no facts at all — cannot, and the executor validates the account
        // itself the moment the relay answers, so it would claim this computer with no question.
        // One fresh read through the one inspection owner; if the relay still cannot be reached,
        // the executor's own `auth status` answers `auth_unavailable` and it stops by name.
        return await inspect({ fresh: true }).catch(() => settled ?? PENDING_INSPECTION);
    };

    const launch = async (params: DesktopSetupStartParams, target: LocalMachineSetupTarget): Promise<DesktopSetupStartOutcome> => {
        const taskId = await params.start(buildLocalMachineSetupSystemTaskSpec({
            ...target,
            ...(params.reconsiderCli ? { reconsiderCli: true } : {}),
        }));
        return { taskId };
    };

    /** The validated account an answered account move is about, carried to the executor (D1). */
    const consentedAccountId = (decision: RelayReconciliationDecision, ambient: DesktopLocalInspection): string | null => (
        decision === 'confirm_account' && ambient.status === 'resolved' ? ambient.facts.auth.validatedAccountId : null
    );

    const startSetup: DesktopSetupCoordinator['startSetup'] = async (params) => {
        const target = resolveDesktopSetupTarget();
        const ambient = await readAmbient();
        const expectation: DesktopSetupExpectation = {
            relayUrl: target.activeRelayUrl,
            localRelayUrl: target.activeLocalRelayUrl,
            accountId: target.expectedAccountId,
        };
        const decision = resolveRelayReconciliationConsent({
            inspection: ambient,
            observedExpectation,
            target: expectation,
            alwaysMoveDefaultFollowingService: readAlwaysMoveDefaultFollowingService(),
        });
        // An explicit request is the relay answer; only the account move is asked again (D1).
        if (decision === 'confirm_account' && !(await askToMove(decision, ambient, expectation, params.confirm))) {
            return null;
        }
        return await launch(params, { ...target, replaceAccountId: consentedAccountId(decision, ambient) });
    };

    const reconcile: DesktopSetupCoordinator['reconcile'] = async (params) => {
        const ambient = await readAmbient();
        const target = readCurrentExpectation();
        if (keptBackgroundServiceApplies({ inspection: ambient, target, kept: readKeptBackgroundService() })) {
            return null;
        }
        const decision = resolveRelayReconciliationConsent({
            inspection: ambient,
            observedExpectation,
            target,
            alwaysMoveDefaultFollowingService: readAlwaysMoveDefaultFollowingService(),
        });
        if (decision !== 'start' && !(await askToMove(decision, ambient, target, params.confirm))) {
            return null;
        }
        return await launch(params, { ...resolveDesktopSetupTarget(), replaceAccountId: consentedAccountId(decision, ambient) });
    };

    return {
        inspect,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        readInspectionSnapshot: () => snapshot,
        readInspectionRefreshing: () => refreshing,
        readInspectionTaskId: () => inspectionTaskId,
        readObservedExpectation: () => observedExpectation,
        verifyCurrentTarget,
        startSetup,
        reconcile,
    };
}

export const desktopSetupCoordinator: DesktopSetupCoordinator = createDesktopSetupCoordinator({
    runner: getSystemTasksRunner,
});
