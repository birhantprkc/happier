import * as React from 'react';
import {
    parseSetupServiceConsentPromptData,
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
}> = {}) {
    const runner = options.runner ?? getSystemTasksRunner();
    const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
    const [isStarting, setIsStarting] = React.useState(false);
    const [startError, setStartError] = React.useState<string | null>(null);
    const activeTaskSnapshot = useSystemTaskSnapshot(runner, activeTaskId);
    const handledResultTaskIdRef = React.useRef<string | null>(null);

    // Without an explicit spec the coordinator composes the app's relay, account and ring and is
    // the only caller of the executor; there is no ambient-target fallback (R3/B6). Starting is
    // always caller-driven: the one automatic start lives in `useDesktopLocalSetupGate`, so no
    // second surface can begin local setup on its own (R9/INV1).
    const start = React.useCallback(async (spec?: SystemTaskSpec) => {
        setIsStarting(true);
        setStartError(null);
        try {
            const taskId = spec
                ? await runner.start(spec)
                : (await desktopSetupCoordinator.startSetup({ start: (setupSpec: SystemTaskSpec) => runner.start(setupSpec) })).taskId;
            handledResultTaskIdRef.current = null;
            setActiveTaskId(taskId);
            return taskId;
        } catch (error) {
            setStartError(error instanceof Error ? error.message : 'system_task_start_failed');
            throw error;
        } finally {
            setIsStarting(false);
        }
    }, [runner]);

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
        runner,
        start,
        startError,
    };
}
