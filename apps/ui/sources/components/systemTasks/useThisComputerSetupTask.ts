import * as React from 'react';
import {
    parseSetupAccountConsentPromptData,
    parseSetupCliChoicePromptData,
    parseSetupServiceConsentPromptData,
    type SetupCliChoice,
    type SetupCliChoicePromptPayload,
    type SetupServiceConsentPromptPayload,
    type SystemTaskEvent,
    type SystemTaskResult,
    type SystemTaskSpec,
} from '@happier-dev/protocol';

import {
    approveSetupPairingForTarget,
    readSetupPairingPrompt,
    type SetupPairingApprovalTarget,
    type SetupUnmanagedCliDecision,
} from '@/auth/terminal/approveSetupPairingForTarget';

import { desktopSetupCoordinator } from '@/setup/desktopSetupCoordinator';
import type { ThisComputerMoveRequest } from '@/setup/presentRelayReconciliationConsent';
import { resolveAppAccountLabel, resolveDaemonAccountLabel } from '@/setup/thisComputerLabels';
import { toRelayHostDisplay } from '@/sync/domains/server/url/serverUrlDisplay';

import { getSystemTasksRunner } from './systemTasksRuntime';
import { useSystemTaskSnapshot } from './useSystemTaskSnapshot';
import type { SystemTaskRunState, SystemTaskRunner } from './types';

/**
 * What the person can still do about a failed setup run, when it is something the app can offer.
 * Today that is exactly one thing: authenticate this relay. A pairing that could not complete has
 * no separate follow-up — the app approves the pairing itself (UD3/R4), so there is nothing for a
 * human to approve anywhere.
 */
export type ThisComputerSetupFollowUp = 'auth' | null;

/**
 * Explicit-target approval configuration for the setup task's pairing prompt: the relay and the
 * account the app sent the executor, plus the app's profile id for that relay (credential scope).
 * The focused relay is never consulted, and a caller that cannot name both relay and account gets
 * no approval. Install ownership is deliberately absent — it rides the live prompt, which
 * describes the CLI actually asking.
 */
export type ThisComputerSetupAuthRequestApproval = SetupPairingApprovalTarget;

/**
 * What the executor learned from `happier service install --dry-run --json` and needs a decision
 * on (INV9). Presented, never re-evaluated, by the UI. The payload shape and its parsing live in
 * `@happier-dev/protocol`'s setup task contract, which the executor builds through.
 */
export type SetupServiceConsentPrompt = SetupServiceConsentPromptPayload & Readonly<{ taskId: string }>;

export function readSetupServiceConsentPrompt(event: SystemTaskEvent): SetupServiceConsentPrompt | null {
    if (event.type !== 'prompt') return null;
    const payload = parseSetupServiceConsentPromptData(event.data);
    return payload ? { taskId: event.taskId, ...payload } : null;
}

export function resolveThisComputerSetupFollowUp(result: SystemTaskResult | null): ThisComputerSetupFollowUp {
    if (!result || result.ok) {
        return null;
    }
    if (result.error.code === 'not_authenticated') {
        return 'auth';
    }
    return null;
}

/**
 * D1 — the executor's account question, as the one account-move request the app already asks
 * with: the account the target relay's credentials belong to, the one the app is signed in as,
 * and the relay both are on.
 */
export function readSetupAccountConsentRequest(event: SystemTaskEvent): Extract<ThisComputerMoveRequest, { kind: 'account' }> | null {
    if (event.type !== 'prompt') return null;
    const payload = parseSetupAccountConsentPromptData(event.data);
    if (!payload) return null;
    return {
        kind: 'account',
        fromAccountLabel: resolveDaemonAccountLabel({ accountLabel: payload.currentAccountLabel, validatedAccountId: payload.currentAccountId }) ?? '',
        toAccountLabel: resolveAppAccountLabel(payload.expectedAccountId),
        relayHost: toRelayHostDisplay(payload.relayUrl),
        fromRelayHost: null,
    };
}

/** R12 — the executor's one-CLI question, or `null` for any other event. */
export function readSetupCliChoicePrompt(event: SystemTaskEvent): SetupCliChoicePromptPayload | null {
    return event.type === 'prompt' ? parseSetupCliChoicePromptData(event.data) : null;
}

/** The canonical one-CLI question, loaded when it is actually asked. */
async function presentCliChoiceDefault(prompt: SetupCliChoicePromptPayload): Promise<SetupCliChoice | null> {
    const { presentCliChoice } = await import('@/setup/presentCliChoice');
    return await presentCliChoice(prompt);
}

/** What starting a setup run may ask the executor for, beyond the app's explicit target. */
export type ThisComputerSetupStartOptions = Readonly<{
    /** R12 — Settings' change action: ask the one-CLI question again through this same run. */
    reconsiderCli?: boolean;
}>;

/** The canonical account question, loaded when it is actually asked. `true` means move. */
async function presentAccountConsent(request: ThisComputerMoveRequest): Promise<boolean> {
    const { presentRelayReconciliationConsent } = await import('@/setup/presentRelayReconciliationConsent');
    return (await presentRelayReconciliationConsent(request)) !== 'keep';
}

export function useThisComputerSetupTask(options: Readonly<{
    runner?: SystemTaskRunner;
    onSucceeded?: (snapshot: SystemTaskRunState) => void;
    /**
     * When set, the task's pairing prompt is answered automatically through
     * `approveSetupPairingForTarget`. When absent, a pairing prompt is declined by name rather
     * than left unanswered — nothing in 0.2 can answer it by hand, and an unanswered prompt is a
     * silent hang.
     */
    authRequestApproval?: ThisComputerSetupAuthRequestApproval;
    /**
     * Asks the person at the keyboard whether a CLI this app's install path did not place may be
     * approved. When absent such a CLI is refused by name rather than approved unattended; the
     * desktop-managed case never reaches this callback.
     */
    onUnmanagedCliConsentRequired?: (decision: SetupUnmanagedCliDecision) => Promise<boolean>;
    /**
     * Presents the executor's service-ownership decision (UD5) and resolves with the user's
     * answer. When absent, the prompt is declined by name so the executor stops before mutating
     * anything, rather than waiting forever.
     */
    onServiceConsentRequired?: (prompt: SetupServiceConsentPrompt) => Promise<boolean>;
    /**
     * D1 — the executor found the target relay's credentials signed in as another account and asks
     * before claiming this computer from it. Defaults to the app's one account question, so no
     * surface can start setup without being able to answer it; `true` means move.
     */
    onAccountConsentRequired?: (request: ThisComputerMoveRequest) => Promise<boolean>;
    /**
     * R12 — the executor found a `happier` this app did not install and asks, once, who manages
     * the command line. Defaults to the app's one presenter, so every surface that starts setup
     * can answer it; `null` means the question was dismissed and the run stops unchanged.
     */
    onCliChoiceRequired?: (prompt: SetupCliChoicePromptPayload) => Promise<SetupCliChoice | null>;
}> = {}) {
    const runner = options.runner ?? getSystemTasksRunner();
    const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
    const [isStarting, setIsStarting] = React.useState(false);
    const [startError, setStartError] = React.useState<string | null>(null);
    const activeTaskSnapshot = useSystemTaskSnapshot(runner, activeTaskId);
    const handledResultTaskIdRef = React.useRef<string | null>(null);

    // `launch` hands one explicit executor spec to the runner and makes it this hook's run; it is
    // what the coordinator calls once the one question — if the facts called for one — is answered.
    const launch = React.useCallback(async (spec: SystemTaskSpec): Promise<string> => {
        setStartError(null);
        try {
            const taskId = await runner.start(spec);
            handledResultTaskIdRef.current = null;
            setActiveTaskId(taskId);
            return taskId;
        } catch (error) {
            setStartError(error instanceof Error ? error.message : 'system_task_start_failed');
            throw error;
        }
    }, [runner]);

    // The coordinator composes the app's relay, account and ring and is the only caller of the
    // executor; there is no ambient-target fallback (R3/B6). Starting is always caller-driven: the
    // one automatic start lives in `useDesktopLocalSetupGate` (mounted once, by the shell's
    // `DesktopLocalSetupRuntime`), so no second surface can begin local
    // setup on its own (R9/INV1). Resolves `null` when the person kept the daemon where it is (D1).
    const start = React.useCallback(async (startOptions: ThisComputerSetupStartOptions = {}): Promise<string | null> => {
        setIsStarting(true);
        setStartError(null);
        try {
            const outcome = await desktopSetupCoordinator.startSetup({
                start: launch,
                ...(startOptions.reconsiderCli ? { reconsiderCli: true } : {}),
            });
            return outcome?.taskId ?? null;
        } catch (error) {
            setStartError(error instanceof Error ? error.message : 'system_task_start_failed');
            throw error;
        } finally {
            setIsStarting(false);
        }
    }, [launch]);

    const cancel = React.useCallback(() => {
        if (!activeTaskId) {
            return;
        }
        void runner.cancel(activeTaskId);
    }, [activeTaskId, runner]);

    // Answers the setup task's prompts — the service-consent decision and the pairing request. The
    // three-argument runner subscription replays
    // already-recorded events, so a prompt emitted between `runner.start()` and this effect is
    // still delivered; the signature set keeps handling exactly-once across replays and
    // re-subscriptions. The primitives are destructured so an inline options object at the
    // caller does not re-run this effect on every render.
    const expectedRelayUrl = options.authRequestApproval?.expectedRelayUrl;
    const expectedAccountId = options.authRequestApproval?.expectedAccountId;
    const approvalServerId = options.authRequestApproval?.serverId;
    const onServiceConsentRequiredRef = React.useRef(options.onServiceConsentRequired);
    onServiceConsentRequiredRef.current = options.onServiceConsentRequired;
    const onUnmanagedCliConsentRequiredRef = React.useRef(options.onUnmanagedCliConsentRequired);
    onUnmanagedCliConsentRequiredRef.current = options.onUnmanagedCliConsentRequired;
    const onAccountConsentRequiredRef = React.useRef(options.onAccountConsentRequired);
    onAccountConsentRequiredRef.current = options.onAccountConsentRequired;
    const onCliChoiceRequiredRef = React.useRef(options.onCliChoiceRequired);
    onCliChoiceRequiredRef.current = options.onCliChoiceRequired;
    const handledPromptSignaturesRef = React.useRef(new Set<string>());
    React.useEffect(() => {
        if (!activeTaskId) {
            return;
        }
        const handled = handledPromptSignaturesRef.current;
        return runner.subscribe(
            activeTaskId,
            (event) => {
                const consent = readSetupServiceConsentPrompt(event);
                if (consent) {
                    const consentSignature = `${event.taskId}:${event.tsMs}:consent`;
                    if (handled.has(consentSignature)) {
                        return;
                    }
                    handled.add(consentSignature);
                    const present = onServiceConsentRequiredRef.current;
                    if (!present) {
                        void runner.respond(activeTaskId, { approved: false, reason: 'consent_unavailable' });
                        return;
                    }
                    void present(consent).then(
                        (approved) => runner.respond(activeTaskId, { approved: approved === true }),
                        () => runner.respond(activeTaskId, { approved: false, reason: 'consent_failed' }),
                    );
                    return;
                }
                const cliChoice = readSetupCliChoicePrompt(event);
                if (cliChoice) {
                    const choiceSignature = `${event.taskId}:${event.tsMs}:cliChoice`;
                    if (handled.has(choiceSignature)) {
                        return;
                    }
                    handled.add(choiceSignature);
                    void (onCliChoiceRequiredRef.current ?? presentCliChoiceDefault)(cliChoice).then(
                        (choice) => runner.respond(activeTaskId, { choice }),
                        () => runner.respond(activeTaskId, { choice: null }),
                    );
                    return;
                }
                const accountMove = readSetupAccountConsentRequest(event);
                if (accountMove) {
                    const accountSignature = `${event.taskId}:${event.tsMs}:account`;
                    if (handled.has(accountSignature)) {
                        return;
                    }
                    handled.add(accountSignature);
                    void (onAccountConsentRequiredRef.current ?? presentAccountConsent)(accountMove).then(
                        (approved) => runner.respond(activeTaskId, { approved: approved === true }),
                        () => runner.respond(activeTaskId, { approved: false, reason: 'consent_failed' }),
                    );
                    return;
                }
                const prompt = readSetupPairingPrompt(event);
                if (!prompt) {
                    return;
                }
                const signature = `${event.taskId}:${event.tsMs}:${prompt.publicKeyB64Url}`;
                if (handled.has(signature)) {
                    return;
                }
                handled.add(signature);
                // No relay or no account means nothing to bind the approval to; refuse by name
                // rather than approve a pairing this run cannot vouch for.
                if (!expectedRelayUrl || !expectedAccountId) {
                    void runner.respond(activeTaskId, { approved: false, reason: 'approval_unavailable' });
                    return;
                }
                const confirmUnmanagedCli = onUnmanagedCliConsentRequiredRef.current;
                void approveSetupPairingForTarget({
                    prompt,
                    activeTaskId,
                    target: {
                        expectedRelayUrl,
                        expectedAccountId,
                        ...(approvalServerId ? { serverId: approvalServerId } : {}),
                    },
                    ...(confirmUnmanagedCli ? { confirmUnmanagedCli } : {}),
                    respond: (answer) => runner.respond(activeTaskId, answer),
                });
            },
            () => {},
        );
    }, [activeTaskId, approvalServerId, expectedAccountId, expectedRelayUrl, runner]);

    // The success callback is read through a ref so this effect depends on the run it reports, not
    // on the caller's options object — every caller passes an inline literal, so depending on it
    // re-ran the effect on every render and left the exactly-once guarantee resting entirely on
    // the task-id guard.
    const onSucceededRef = React.useRef(options.onSucceeded);
    onSucceededRef.current = options.onSucceeded;
    React.useEffect(() => {
        if (!activeTaskSnapshot?.result?.ok) {
            return;
        }
        if (handledResultTaskIdRef.current === activeTaskSnapshot.taskId) {
            return;
        }
        handledResultTaskIdRef.current = activeTaskSnapshot.taskId;
        onSucceededRef.current?.(activeTaskSnapshot);
    }, [activeTaskSnapshot]);

    return {
        activeTaskId,
        activeTaskSnapshot,
        cancel,
        isStarting,
        launch,
        runner,
        start,
        startError,
    };
}
