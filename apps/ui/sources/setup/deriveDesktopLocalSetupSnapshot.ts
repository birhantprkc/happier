import { createRelayUrlComparableKeySafe } from '@/sync/domains/server/relayDrift/relayDriftModel';

/**
 * Whether the installed background service starts the daemon at login — the CLI's own
 * `at-login | on-demand` vocabulary, carried unchanged from `happier daemon status --json`
 * through the toggle that writes it back. One name for one concept, so nothing in between has to
 * translate; `null` is UNKNOWN and is never one of the modes.
 */
export type DesktopBackgroundServiceAutostartMode = 'at-login' | 'on-demand';

/**
 * The ambient facts `daemon.service.status.v1` reports about this computer. They describe the
 * CLI that answered, its configured relay, its validated credentials, the installed service and
 * — through `runtimeConvergence` — the daemon that is actually running (plan INV8). They never
 * include an account-wide machine count (A4) and are never target-scoped (D3).
 */
export type DesktopLocalReadinessFacts = Readonly<{
    acquisition: Readonly<{
        command: string;
        provenance: 'managed' | 'override';
    }>;
    server: Readonly<{
        serverUrl: string | null;
        publicServerUrl: string | null;
        localServerUrl: string | null;
        comparableKey: string | null;
    }>;
    auth: Readonly<{
        credentialState: 'missing' | 'rejected' | 'valid' | 'unknown' | null;
        /** The account the relay confirmed the CLI credentials belong to; null unless `credentialState` is `valid`. */
        validatedAccountId: string | null;
        /** The account named by the credentials on disk. Diagnostic; never sufficient for readiness. */
        accountId: string | null;
        machineId: string | null;
    }>;
    service: Readonly<{
        installed: boolean;
        running: boolean;
        /**
         * The autostart mode the installed definition declares. `null` when the CLI that answered
         * does not report one. Entry policy reads it for exactly one decision: an `on-demand`
         * service that is simply not running yet is the deal the user made — "it answers while the
         * app is open" — so starting it is a check, not maintenance to announce (H6). The desktop
         * settings toggle and the app-close guard project the same fact.
         */
        autostart: DesktopBackgroundServiceAutostartMode | null;
        /**
         * What the installed service's own definition says it follows. `default-following` is the
         * mode whose contract is "track the selected default relay"; `pinned` was deliberately
         * fixed to one relay. **`null` means UNKNOWN** — an older CLI that reports no mode, or a
         * definition that proved none — and readers fail closed on it (UD5). It is never a
         * default and never evidence that this service is the app's to move.
         */
        targetMode: 'default-following' | 'pinned' | null;
    }>;
    runtimeConvergence: Readonly<{
        controlReachable: boolean;
        serviceOwnsRunningDaemon: boolean;
        machineIdMatches: boolean;
        cliVersionMatches: boolean;
    }> | null;
}>;

export type DesktopLocalInspection =
    | Readonly<{ status: 'pending' }>
    | Readonly<{ status: 'failed'; error: Readonly<{ code: string; message: string }> }>
    | Readonly<{ status: 'resolved'; facts: DesktopLocalReadinessFacts }>;

/** The identity the app selected. Compared against the immutable ambient facts; a change re-runs nothing. */
export type DesktopSetupExpectation = Readonly<{
    relayUrl: string;
    localRelayUrl: string | null;
    accountId: string | null;
}>;

/**
 * INV10 — readiness also needs proof that this daemon is reachable **now**, which is one
 * successful read-only machine RPC through the canonical owner. Absent means the proof has not
 * come back yet, so nothing is ready: the gate fails closed on an unanswered machine.
 */
export type DesktopSetupReachability = 'reachable' | 'unreachable';

export type DesktopLocalSetupInput = Readonly<{
    inspection: DesktopLocalInspection;
    expected: DesktopSetupExpectation;
    reachability?: DesktopSetupReachability;
    /**
     * H6 — the on-demand quiet start has already had its turn for these facts. Until then, facts
     * that say "installed, stopped, on-demand" are an unsettled check (`service_start_pending`):
     * the app is about to start the service it already installed. Afterwards they are settled, so
     * a service still stopped once the start has run carries its own failure instead of leaving
     * the surface checking something nothing is going to start.
     */
    backgroundServiceStartAttempted?: boolean;
}>;

/** R14/UD5: the ephemeral in-run facts that decide how a blocking fact is presented. */
export type DesktopSetupEntryContext = Readonly<{
    authenticatedThisRun: boolean;
    /**
     * UD4 — whether this app run has already put the shell in front of the user. It is the fact
     * the entry policy actually needs: `authenticatedThisRun` is set once at sign-in and never
     * cleared, so on its own it would still claim "first run" for maintenance that happens hours
     * later, and take the opaque ground away from an app the user is already working in.
     */
    hasPresentedShell: boolean;
    /**
     * The user was asked something this attempt needed — to move this device's background service
     * to the selected Relay (UD5), or to vouch for a command line this app's install path did not
     * place — and said no. The computer is still not ready for this relay, so nothing claims
     * ready; but the app must not hold a blocking surface over a choice the user just made, so the
     * shell stays visible and the existing drift banner carries the state.
     */
    userDeclinedThisAttempt?: boolean;
}>;

export type DesktopLocalSetupState = 'checking' | 'setup' | 'ready' | 'blocked';

/**
 * `ground`: the opaque first-run ground (UD4). `veil`: blocking maintenance over the shell the
 * user is already in. `shell`: the ordinary authenticated shell.
 */
export type DesktopLocalSetupPresentation = 'ground' | 'shell' | 'veil';

export type DesktopLocalSetupReason =
    | 'relay_mismatch'
    | 'not_authenticated'
    | 'account_mismatch'
    | 'machine_unregistered'
    | 'service_not_installed'
    | 'daemon_not_converged'
    | 'runtime_unknown'
    | 'inspection_failed'
    | 'credentials_unverified'
    | 'reachability_pending'
    | 'service_start_pending'
    | 'machine_unreachable';

export type DesktopLocalSetupSnapshot = Readonly<{
    state: DesktopLocalSetupState;
    presentation: DesktopLocalSetupPresentation;
    reason: DesktopLocalSetupReason | null;
}>;

/**
 * Whether the daemon's configured relay is the one the app expects. Every relay comparison in the
 * setup corridor goes through this one comparer so the UD5 reconciliation check and the readiness
 * check cannot disagree about what "same relay" means.
 */
export function daemonRelayMatchesExpectation(facts: DesktopLocalReadinessFacts, expected: DesktopSetupExpectation): boolean {
    const accepted = new Set<string>();
    for (const url of [expected.relayUrl, expected.localRelayUrl]) {
        const key = createRelayUrlComparableKeySafe(url);
        if (key) accepted.add(key);
    }
    if (accepted.size === 0) {
        return false;
    }
    const daemonKeys = [
        facts.server.comparableKey,
        createRelayUrlComparableKeySafe(facts.server.serverUrl),
        createRelayUrlComparableKeySafe(facts.server.publicServerUrl),
        createRelayUrlComparableKeySafe(facts.server.localServerUrl),
    ].filter((key): key is string => typeof key === 'string' && key.length > 0);
    return daemonKeys.some((key) => accepted.has(key));
}

function resolveSetupReason(facts: DesktopLocalReadinessFacts, expected: DesktopSetupExpectation): DesktopLocalSetupReason | null {
    if (!daemonRelayMatchesExpectation(facts, expected)) {
        return 'relay_mismatch';
    }
    if (facts.auth.credentialState === 'unknown') {
        return 'credentials_unverified';
    }
    if (facts.auth.credentialState !== 'valid' || !facts.auth.validatedAccountId) {
        return 'not_authenticated';
    }
    if (facts.auth.validatedAccountId !== expected.accountId) {
        return 'account_mismatch';
    }
    if (!facts.auth.machineId) {
        return 'machine_unregistered';
    }
    if (!facts.service.installed) {
        return 'service_not_installed';
    }
    const convergence = facts.runtimeConvergence;
    if (!convergence) {
        return 'runtime_unknown';
    }
    if (
        !convergence.controlReachable
        || !convergence.serviceOwnsRunningDaemon
        || !convergence.machineIdMatches
        || !convergence.cliVersionMatches
    ) {
        return 'daemon_not_converged';
    }
    return null;
}

/**
 * Whether this computer's daemon still needs to be paired for the relay it is configured for: the
 * relay could not confirm its credentials, or it has no machine of its own yet.
 *
 * It is the one projection of "needs auth" the desktop surfaces share — the drift classifier and
 * the local-daemon settings row — so the banner and the row beside it cannot describe the same
 * computer differently. Readiness is never this: that is `verifyCurrentTarget` alone (INV8/INV10).
 */
export function daemonNeedsAuthFromFacts(facts: DesktopLocalReadinessFacts): boolean {
    return facts.auth.credentialState !== 'valid' || facts.auth.machineId === null;
}

/**
 * H6 — the installed service is the app's own on-demand one and is simply not running yet.
 *
 * That is not drift: the settings toggle promised "this computer answers while the app is open",
 * so the app starting the service it already installed is the promise being kept. Every other fact
 * has to be aligned first — this is only ever reached for `daemon_not_converged`, i.e. the relay,
 * credentials, account, machine id and installation all match what the app expects.
 */
function onDemandServiceNeedsStart(facts: DesktopLocalReadinessFacts): boolean {
    return facts.service.installed && !facts.service.running && facts.service.autostart === 'on-demand';
}

/**
 * Whether the app's re-read facts already describe a converged local runtime for this identity
 * (INV8). It is the same private reason resolver the snapshot uses, so the gate cannot disagree
 * with the snapshot about when the reachability proof is worth issuing.
 */
export function desktopLocalRuntimeConverged(
    inspection: DesktopLocalInspection,
    expected: DesktopSetupExpectation,
): boolean {
    return inspection.status === 'resolved'
        && !!expected.accountId
        && resolveSetupReason(inspection.facts, expected) === null;
}

/**
 * The one pure entry policy (plan §3.1). `(facts, entryContext) → state + presentation`.
 *
 * "Ready" is proven by the running daemon's convergence and the relay-validated account (INV8)
 * **and** by the machine answering a read-only RPC (INV10); credentials on disk beside a live PID
 * prove nothing, and neither does convergence alone.
 *
 * One rule decides presentation, and it turns on whether the facts have SETTLED (R14/UD4):
 * while a check is still running nothing is wrong yet, so the user keeps the ordinary shell —
 * except on a first run, where no shell has been presented and the opaque ground is the whole
 * surface. Once a fact settles against the app — setup needed, credentials unverifiable, the
 * inspection failed, the machine unreachable — it is presented, never hidden: the ground on a
 * first run, the veil over the shell afterwards. A settled failure behind a bare shell is how a
 * failed setup became silently permanent, and the veil is what carries its Retry.
 */
export function deriveDesktopLocalSetupSnapshot(
    input: DesktopLocalSetupInput,
    entryContext: DesktopSetupEntryContext,
): DesktopLocalSetupSnapshot {
    // The user just answered this attempt's question with "no". Holding a blocking surface over
    // a choice they made would be a retry trap, so the shell comes back and the existing drift /
    // repair entry carries the state until they return to it.
    const firstRun = entryContext.authenticatedThisRun && !entryContext.hasPresentedShell;
    const settled: DesktopLocalSetupPresentation = entryContext.userDeclinedThisAttempt
        ? 'shell'
        : (firstRun ? 'ground' : 'veil');
    const unsettled: DesktopLocalSetupPresentation = firstRun && !entryContext.userDeclinedThisAttempt
        ? 'ground'
        : 'shell';

    if (input.inspection.status === 'pending' || !input.expected.accountId) {
        return { state: 'checking', presentation: unsettled, reason: null };
    }
    if (input.inspection.status === 'failed') {
        return { state: 'blocked', presentation: settled, reason: 'inspection_failed' };
    }

    const reason = resolveSetupReason(input.inspection.facts, input.expected);
    if (reason === null) {
        if (input.reachability === 'reachable') {
            return { state: 'ready', presentation: 'shell', reason: null };
        }
        if (input.reachability === 'unreachable') {
            return { state: 'blocked', presentation: settled, reason: 'machine_unreachable' };
        }
        return { state: 'checking', presentation: unsettled, reason: 'reachability_pending' };
    }
    if (reason === 'credentials_unverified') {
        // The relay could not be reached to say whether the stored credentials are still good.
        // That is a fact about the CHECK, not about this computer, and on a relaunch it clears
        // itself the next time the network answers — so nothing is ready, and nothing takes the
        // app away either.
        //
        // A first run has no shell to fall back to, and nothing re-inspects on its own, so leaving
        // it unsettled there is an opaque ground that checks forever with no action. The executor
        // is the owner of "validate the credentials for this relay": it pairs if the relay answers
        // now, and fails by name — with a Retry — if it does not.
        return firstRun
            ? { state: 'setup', presentation: settled, reason }
            : { state: 'blocked', presentation: unsettled, reason };
    }
    if (reason === 'daemon_not_converged'
        && !input.backgroundServiceStartAttempted
        && onDemandServiceNeedsStart(input.inspection.facts)) {
        return { state: 'checking', presentation: unsettled, reason: 'service_start_pending' };
    }
    return { state: 'setup', presentation: settled, reason };
}
