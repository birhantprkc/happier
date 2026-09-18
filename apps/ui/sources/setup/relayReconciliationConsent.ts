import {
    daemonRelayMatchesExpectation,
    type DesktopLocalInspection,
    type DesktopLocalReadinessFacts,
    type DesktopSetupExpectation,
} from './deriveDesktopLocalSetupSnapshot';

/**
 * `start`: run the executor now. `confirm`: ask the user before the app moves their background
 * service.
 */
export type RelayReconciliationDecision = 'start' | 'confirm';

export type RelayReconciliationInput = Readonly<{
    /** The one ambient inspection (plan §3.3) — immutable for this app open. */
    inspection: DesktopLocalInspection;
    /** The relay and account the app expected when those facts were read. */
    observedExpectation: DesktopSetupExpectation | null;
    /** The device-local "always move my default-following service with my selected default relay". */
    alwaysMoveDefaultFollowingService: boolean;
}>;

/**
 * UD5, decided from current facts only — never installation history (D7).
 *
 * The app may silently move a background service only when the facts prove the service is its
 * own and is where the app last put it:
 *
 * - **that is default-following** — `service.targetMode` says so, and it is asked of every
 *   installed service before anything else, running or stopped. That is the only mode whose
 *   contract is "track the selected default relay". A `pinned` service was deliberately fixed to
 *   one relay, and `null` means nothing proved a mode at all (an older CLI, or an unreadable
 *   definition); neither is evidence the app may move it, so both are asked about once. This
 *   fact is required because the rest of the picture cannot supply it: an installed service whose
 *   running daemon its own installation owns looks identical whether it is pinned or following,
 *   so without the mode a remembered "always move my default-following service" could repoint a
 *   pinned one;
 * - **on the relay the app last expected**, compared through the corridor's one relay comparer;
 * - **as an account that does not contradict the app's** — the relay validated the daemon's
 *   credentials, and either the app had no account expectation when it looked or the accounts
 *   match. A known-different account is the mismatch UD5 names.
 *
 * A manual, foreign-home, conflicting or multiple service is one this installation does not own at
 * all, so this function does not classify it: the executor's `service install --dry-run --json`
 * does, and raises the CLI's own consent (INV9). Restating that ownership policy here would put a
 * second, weaker decision in the UI. What this function decides is only UD5's own question —
 * whether the app may move the service it does own to the relay the user selected.
 *
 * The device preference therefore reaches only the compatible default-following ask; it can never
 * suppress the CLI's ownership consent, because that consent is not raised from here.
 */
export function resolveRelayReconciliationConsent(input: RelayReconciliationInput): RelayReconciliationDecision {
    if (input.inspection.status !== 'resolved' || !input.observedExpectation) {
        return 'confirm';
    }
    const facts = input.inspection.facts;
    // UD5 turns on what this service IS, not on whether it happens to be running. Only a
    // default-following service is the app's to move with its selected default relay; `pinned` and
    // UNKNOWN are asked about once, and neither may be reached past by the device preference. This
    // comes first because a stopped service has no running daemon for anything to own: asking
    // about ownership before the mode read every stopped definition — a pinned one included — as
    // "not the app's at all". Stopping is not consent.
    if (facts.service.installed && facts.service.targetMode !== 'default-following') {
        return 'confirm';
    }
    if (!installationOwnsService(facts)) {
        // Nothing of this installation's to move: no service at all, or a bare process it does not
        // own. A first install is not a relay move, and a service this installation does not own
        // is classified by the executor's own `service install --dry-run --json` (INV9) rather
        // than asked about twice here.
        return facts.runtimeConvergence === null ? 'confirm' : 'start';
    }
    if (facts.runtimeConvergence === null) {
        // The CLI that answered described no running daemon at all, so nothing below can be
        // compared honestly. Fail closed.
        return 'confirm';
    }

    const relayAligned = daemonRelayMatchesExpectation(facts, input.observedExpectation);
    const validatedAccountId = facts.auth.validatedAccountId;
    const accountAligned = validatedAccountId !== null
        && (input.observedExpectation.accountId === null || validatedAccountId === input.observedExpectation.accountId);
    if (relayAligned && accountAligned) {
        return 'start';
    }
    return input.alwaysMoveDefaultFollowingService ? 'start' : 'confirm';
}

/**
 * The ONE question "is this background service this installation's to move?", asked the same way
 * by the UD5 consent decision and by the gate's relaunch discriminator below.
 *
 * Ownership is deliberately generous and deliberately independent of whether a daemon is running:
 * a running daemon its own installation owns proves it, and so does an installed definition whose
 * target mode the CLI could read. A service that is merely stopped — which is exactly where the
 * app-close guard leaves an on-demand one — is still the user's. Two predicates for this concept
 * lived in this file and disagreed: the gate routed a stopped service to reconciliation because its
 * mode was known, and reconciliation then started without asking because nothing was running for
 * it, repointing a service nobody was asked about.
 */
function installationOwnsService(facts: DesktopLocalReadinessFacts): boolean {
    return facts.service.installed
        && (facts.runtimeConvergence?.serviceOwnsRunningDaemon === true || facts.service.targetMode !== null);
}

/**
 * B2/UD5 — whether the facts describe a background service this installation owns that the
 * executor would MOVE to reach the app's current target, rather than converge for the first time.
 *
 * The gate's other discriminator — the relay the app expected when the facts were read — cannot
 * answer this after a relaunch: an ambient device-scope switch is persisted, so on the next open
 * the app's expectation and its current identity agree while the daemon is still somewhere else.
 * Asked of the facts instead, the question has the same answer whether it is asked in the same run
 * or a week later, which is what keeps a relaunch from silently repointing someone's daemon.
 *
 * "This installation owns it" is deliberately generous: a running daemon its own installation owns
 * proves it, and so does an installed definition whose target mode the CLI could read — a service
 * that is merely stopped is still the user's. Nothing installed at all contradicts nothing: a
 * first install is not a move. The consent decision itself stays with
 * `resolveRelayReconciliationConsent`, which this function never second-guesses.
 */
export function appOwnedServiceContradictsTarget(input: Readonly<{
    inspection: DesktopLocalInspection;
    target: DesktopSetupExpectation;
}>): boolean {
    if (input.inspection.status !== 'resolved') {
        return false;
    }
    const facts = input.inspection.facts;
    if (!installationOwnsService(facts)) {
        return false;
    }
    if (!daemonRelayMatchesExpectation(facts, input.target)) {
        return true;
    }
    const validatedAccountId = facts.auth.validatedAccountId;
    return validatedAccountId !== null
        && input.target.accountId !== null
        && validatedAccountId !== input.target.accountId;
}
