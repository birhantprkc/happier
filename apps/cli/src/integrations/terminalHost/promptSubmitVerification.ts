const DEFAULT_POST_SUBMIT_SETTLE_MS = 50;
const DEFAULT_PRE_SUBMIT_POLL_MS = 250;

export type TerminalPromptSubmitVerificationPolicy = Readonly<{
  shouldVerifyAfterSubmit(promptText: string): boolean;
  isPromptStagedBeforeSubmit(params: Readonly<{
    promptText: string;
    screenText: string;
  }>): boolean;
  isPromptStillPendingAfterSubmit(params: Readonly<{
    promptText: string;
    screenText: string;
  }>): boolean;
}>;

export type TerminalPromptSubmitCommandResult = 'success' | 'timeout' | 'failed';

export type TerminalPromptSubmissionResult =
  | Readonly<{ success: true }>
  | Readonly<{
    success: false;
    reason: 'verification_failed' | 'submit_failed' | 'timeout';
    phase: 'after_write_before_enter' | 'after_enter_unknown';
    duplicateRisk: 'possible' | 'likely';
    submitMayHaveReachedPane: boolean;
  }>;

export function resolveTerminalPromptSubmissionFailureReason(
  reason: Extract<TerminalPromptSubmissionResult, { success: false }>['reason'] | 'load_failed' | 'paste_failed',
): 'verification_failed' | 'host_unreachable' | 'timeout' {
  if (reason === 'timeout') return 'timeout';
  if (reason === 'verification_failed') return 'verification_failed';
  return 'host_unreachable';
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function normalizeSubmitResult(result: TerminalPromptSubmitCommandResult | void): TerminalPromptSubmitCommandResult {
  return result ?? 'success';
}

export async function runTerminalPromptSubmission(params: Readonly<{
  promptText: string;
  verifyStagedBeforeSubmit?: ((params: Readonly<{ promptText: string; remainingTimeoutMs?: number | undefined }>) => Promise<boolean>) | undefined;
  submitEnter: (params: Readonly<{ remainingTimeoutMs?: number | undefined }>) => Promise<TerminalPromptSubmitCommandResult | void>;
  verifyAfterSubmit?: ((params: Readonly<{ promptText: string; remainingTimeoutMs?: number | undefined }>) => Promise<boolean>) | undefined;
  remainingTimeoutMs?: (() => number | undefined) | undefined;
  wait?: ((delayMs: number) => Promise<void>) | undefined;
  stagingPollIntervalMs?: number | undefined;
  postSubmitSettleMs?: number | undefined;
}>): Promise<TerminalPromptSubmissionResult> {
  let stagingWasProvenAtDeadline = false;
  const remainingOperationTimeoutMs = (): number | undefined => (
    stagingWasProvenAtDeadline ? undefined : params.remainingTimeoutMs?.()
  );
  const submitOnce = async (): Promise<TerminalPromptSubmitCommandResult> => normalizeSubmitResult(await params.submitEnter({
    remainingTimeoutMs: remainingOperationTimeoutMs(),
  }));
  const postSubmitSettleMs = Math.max(
    0,
    Math.trunc(params.postSubmitSettleMs ?? DEFAULT_POST_SUBMIT_SETTLE_MS),
  );
  const waitForPostSubmitSettle = async (): Promise<void> => {
    if (postSubmitSettleMs <= 0) return;
    await (params.wait ?? defaultWait)(postSubmitSettleMs);
  };

  if (params.verifyStagedBeforeSubmit) {
    const stagingPollIntervalMs = Math.max(
      1,
      Math.trunc(params.stagingPollIntervalMs ?? DEFAULT_PRE_SUBMIT_POLL_MS),
    );
    while (true) {
      const remainingTimeoutMs = params.remainingTimeoutMs?.();
      try {
        if (await params.verifyStagedBeforeSubmit({
          promptText: params.promptText,
          remainingTimeoutMs: remainingTimeoutMs === 0 ? undefined : remainingTimeoutMs,
        })) {
          // Staging and Enter are separate terminal operations. If the exact prompt became
          // observable at the boundary, let the adapter apply its normal bounded Enter/capture
          // timeout instead of passing an already exhausted staging budget.
          stagingWasProvenAtDeadline = remainingTimeoutMs === 0;
          break;
        }
      } catch {
        return {
          success: false,
          reason: 'verification_failed',
          phase: 'after_write_before_enter',
          duplicateRisk: 'possible',
          submitMayHaveReachedPane: false,
        };
      }
      if (remainingTimeoutMs === 0) {
        return {
          success: false,
          reason: 'timeout',
          phase: 'after_write_before_enter',
          duplicateRisk: 'possible',
          submitMayHaveReachedPane: false,
        };
      }
      if (remainingTimeoutMs === undefined) {
        return {
          success: false,
          reason: 'verification_failed',
          phase: 'after_write_before_enter',
          duplicateRisk: 'possible',
          submitMayHaveReachedPane: false,
        };
      }
      await (params.wait ?? defaultWait)(Math.min(stagingPollIntervalMs, remainingTimeoutMs));
    }
  }

  const verifyStillPending = async (): Promise<boolean | null> => {
    try {
      return await params.verifyAfterSubmit?.({
        promptText: params.promptText,
        remainingTimeoutMs: remainingOperationTimeoutMs(),
      }) ?? false;
    } catch {
      return null;
    }
  };

  const verifyStableAbsence = async (): Promise<'cleared' | 'pending' | 'failed'> => {
    const first = await verifyStillPending();
    if (first === null) return 'failed';
    if (first) return 'pending';
    await waitForPostSubmitSettle();
    const confirmation = await verifyStillPending();
    if (confirmation === null) return 'failed';
    return confirmation ? 'pending' : 'cleared';
  };

  const submitted = await submitOnce();
  if (submitted === 'timeout') {
    return {
      success: false,
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      submitMayHaveReachedPane: true,
    };
  }
  if (submitted === 'failed') {
    return {
      success: false,
      reason: 'submit_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      submitMayHaveReachedPane: false,
    };
  }

  if (!params.verifyAfterSubmit) {
    return { success: true };
  }

  await waitForPostSubmitSettle();
  while (true) {
    const verification = await verifyStableAbsence();
    if (verification === 'failed') {
      return {
        success: false,
        reason: 'verification_failed',
        phase: 'after_enter_unknown',
        duplicateRisk: 'likely',
        submitMayHaveReachedPane: true,
      };
    }
    if (verification === 'cleared') return { success: true };

    // The screen can lag behind provider acceptance. Re-observe within the
    // caller's operation budget; another Enter based on a stale draft is not
    // evidence-backed and can act on a different composer by the time it arrives.
    const remainingTimeoutMs = remainingOperationTimeoutMs();
    if (remainingTimeoutMs === undefined || remainingTimeoutMs === 0) {
      return {
        success: false,
        reason: 'verification_failed',
        phase: 'after_enter_unknown',
        duplicateRisk: 'possible',
        submitMayHaveReachedPane: true,
      };
    }
    await (params.wait ?? defaultWait)(Math.min(
      Math.max(1, postSubmitSettleMs),
      remainingTimeoutMs,
    ));
  }
}
