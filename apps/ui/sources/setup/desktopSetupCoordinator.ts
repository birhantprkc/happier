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

import {
    readAlwaysMoveDefaultFollowingService,
    rememberAlwaysMoveDefaultFollowingService,
} from './desktopRelayMovePreference';
import {
    desktopLocalRuntimeConverged,
    type DesktopLocalInspection,
    type DesktopLocalReadinessFacts,
    type DesktopSetupExpectation,
} from './deriveDesktopLocalSetupSnapshot';
import type { RelayReconciliationConsentAnswer } from './presentRelayReconciliationConsent';
import { resolveRelayReconciliationConsent } from './relayReconciliationConsent';

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
 * `startSetup()` is the only path that builds the explicit-target executor spec (R3): it awaits
 * an in-flight inspection so two acquisitions never contend (C3), then hands the spec to the
 * caller's runner adapter, reporting whether the acquisition milestone is already met.
 *
 * No persistence, no lock, no event bus, no generations, no scheduler.
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
    startSetup: (params: Readonly<{ start: (spec: SystemTaskSpec) => Promise<string> }>) => Promise<DesktopSetupStartOutcome>;
    /**
     * R8/L7 — a **direct** Relay/Home preference change, or authentication completing after one.
     * Runs the same preflight and the same idempotent executor as `startSetup`, after UD5 consent.
     * Resolves `null` when the user chose to keep the service where it is.
     */
    reconcile: (params: Readonly<{
        start: (spec: SystemTaskSpec) => Promise<string>;
        confirm: (request: Readonly<{ relayUrl: string }>) => Promise<RelayReconciliationConsentAnswer>;
    }>) => Promise<DesktopSetupStartOutcome | null>;
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
        acquisition: { command, provenance },
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
            machineId: readString(auth.machineId),
        },
        service: {
            installed: readBoolean(service.installed),
            running: readBoolean(service.running),
            autostart: readServiceAutostartMode(service.autostart),
            targetMode: readServiceTargetMode(service.targetMode),
        },
        runtimeConvergence: readRuntimeConvergence(record.runtimeConvergence),
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

export function createDesktopSetupCoordinator(deps: Readonly<{
    runner: () => SystemTaskRunner;
    /** INV10's canonical owner. Read-only, so it keeps its production default. */
    machineRpc?: (params: Readonly<{ machineId: string; serverId: string }>) => Promise<unknown>;
}>): DesktopSetupCoordinator {
    let inspection: Promise<DesktopLocalInspection> | null = null;
    let observedExpectation: DesktopSetupObservedExpectation | null = null;
    let snapshot: DesktopLocalInspection = PENDING_INSPECTION;
    let refreshing = false;
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

    const startSetup: DesktopSetupCoordinator['startSetup'] = async (params) => {
        const target = resolveDesktopSetupTarget();
        // Awaiting an in-flight ambient read keeps two adjacent acquisitions from contending (C3).
        // Its outcome is not consulted: a failed or rejected inspection must not block setup or
        // repair, and a successful one proves nothing about the executor's own progress.
        if (inspection) await inspection.catch(() => null);
        const taskId = await params.start(buildLocalMachineSetupSystemTaskSpec(target));
        return { taskId };
    };

    const reconcile: DesktopSetupCoordinator['reconcile'] = async (params) => {
        const ambient = inspection ? await inspection.catch(() => null) : null;
        const decision = resolveRelayReconciliationConsent({
            inspection: ambient ?? { status: 'pending' },
            observedExpectation,
            alwaysMoveDefaultFollowingService: readAlwaysMoveDefaultFollowingService(),
        });
        if (decision === 'confirm') {
            const answer = await params.confirm({ relayUrl: readCurrentExpectation().relayUrl });
            if (answer === 'keep') {
                return null;
            }
            if (answer === 'always') {
                rememberAlwaysMoveDefaultFollowingService();
            }
        }
        return await startSetup(params);
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
        readObservedExpectation: () => observedExpectation,
        verifyCurrentTarget,
        startSetup,
        reconcile,
    };
}

export const desktopSetupCoordinator: DesktopSetupCoordinator = createDesktopSetupCoordinator({
    runner: getSystemTasksRunner,
});
