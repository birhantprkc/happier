import { describe, expect, it, vi } from 'vitest';

import { runTerminalPromptSubmission } from './promptSubmitVerification';

describe('runTerminalPromptSubmission', () => {
  it('waits for exact prompt staging before sending Enter', async () => {
    const calls: string[] = [];
    let staged = false;

    await expect(runTerminalPromptSubmission({
      promptText: 'first\nsecond',
      verifyStagedBeforeSubmit: async () => {
        calls.push('verify-staged');
        const result = staged;
        staged = true;
        return result;
      },
      submitEnter: async () => {
        calls.push('enter');
        return 'success';
      },
      remainingTimeoutMs: () => 1_000,
      wait: async (delayMs) => {
        calls.push(`wait:${delayMs}`);
      },
    })).resolves.toEqual({ success: true });

    expect(calls).toEqual([
      'verify-staged',
      'wait:250',
      'verify-staged',
      'enter',
    ]);
  });

  it('does not send Enter when exact prompt staging exhausts the write deadline', async () => {
    const verifyStagedBeforeSubmit = vi.fn(async () => false);
    const submitEnter = vi.fn();

    await expect(runTerminalPromptSubmission({
      promptText: 'first\nsecond',
      verifyStagedBeforeSubmit,
      submitEnter,
      remainingTimeoutMs: () => 0,
      wait: async () => {},
    })).resolves.toEqual({
      success: false,
      reason: 'timeout',
      phase: 'after_write_before_enter',
      duplicateRisk: 'possible',
      submitMayHaveReachedPane: false,
    });

    expect(verifyStagedBeforeSubmit).toHaveBeenCalledOnce();
    expect(submitEnter).not.toHaveBeenCalled();
  });

  it('submits when the final deadline observation proves the exact prompt is staged', async () => {
    const submitEnter = vi.fn(async ({ remainingTimeoutMs }: Readonly<{ remainingTimeoutMs?: number | undefined }>) => {
      expect(remainingTimeoutMs).toBeUndefined();
      return 'success' as const;
    });

    await expect(runTerminalPromptSubmission({
      promptText: 'first\nsecond',
      verifyStagedBeforeSubmit: async ({ remainingTimeoutMs }) => {
        expect(remainingTimeoutMs).toBeUndefined();
        return true;
      },
      submitEnter,
      remainingTimeoutMs: () => 0,
      wait: async () => {},
    })).resolves.toEqual({ success: true });

    expect(submitEnter).toHaveBeenCalledOnce();
  });

  it('submits immediately and then verifies the composer', async () => {
    const calls: string[] = [];

    await expect(runTerminalPromptSubmission({
      promptText: 'first\nsecond',
      submitEnter: async () => {
        calls.push('enter');
        return 'success';
      },
      verifyAfterSubmit: async () => {
        calls.push('verify-after');
        return false;
      },
      wait: async () => {},
    })).resolves.toEqual({ success: true });

    expect(calls).toEqual(['enter', 'verify-after', 'verify-after']);
  });

  it('waits for a delayed composer redraw within the operation budget without resubmitting', async () => {
    let elapsedMs = 0;
    const submitEnter = vi.fn(async () => 'success' as const);

    await expect(runTerminalPromptSubmission({
      promptText: 'first\nsecond',
      submitEnter,
      // Claude 2.1.280 can record acceptance before its composer redraws.
      verifyAfterSubmit: async () => elapsedMs < 500,
      remainingTimeoutMs: () => Math.max(0, 1_000 - elapsedMs),
      wait: async (delayMs) => { elapsedMs += delayMs; },
    })).resolves.toEqual({ success: true });

    expect(submitEnter).toHaveBeenCalledOnce();
    expect(elapsedMs).toBeGreaterThanOrEqual(500);
    expect(elapsedMs).toBeLessThanOrEqual(1_000);
  });

  it('keeps delivery ambiguous when the composer remains pending until the operation deadline', async () => {
    let elapsedMs = 0;
    const submitEnter = vi.fn(async () => 'success' as const);

    await expect(runTerminalPromptSubmission({
      promptText: 'first\nsecond',
      submitEnter,
      verifyAfterSubmit: async () => true,
      remainingTimeoutMs: () => Math.max(0, 1_000 - elapsedMs),
      wait: async (delayMs) => { elapsedMs += delayMs; },
    })).resolves.toEqual({
      success: false,
      reason: 'verification_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      submitMayHaveReachedPane: true,
    });

    expect(submitEnter).toHaveBeenCalledOnce();
    expect(elapsedMs).toBe(1_000);
  });

  it('does not invent a retry budget when the caller provides none', async () => {
    await expect(runTerminalPromptSubmission({
      promptText: 'first\nsecond',
      submitEnter: async () => 'success',
      verifyAfterSubmit: async () => true,
      wait: async () => {},
    })).resolves.toMatchObject({ success: false, reason: 'verification_failed' });
  });

  it('keeps delivery ambiguous when post-submit verification is unavailable', async () => {
    let submitCount = 0;

    await expect(runTerminalPromptSubmission({
      promptText: 'first\nsecond',
      submitEnter: async () => {
        submitCount += 1;
        return 'success';
      },
      verifyAfterSubmit: async () => {
        throw new Error('screen capture unavailable');
      },
      wait: async () => {},
    })).resolves.toEqual({
      success: false,
      reason: 'verification_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      submitMayHaveReachedPane: true,
    });

    expect(submitCount).toBe(1);
  });
});
