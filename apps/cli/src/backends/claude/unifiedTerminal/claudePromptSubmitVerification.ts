import type { TerminalPromptSubmitVerificationPolicy } from '@/integrations/terminalHost/promptSubmitVerification';
import { isExactClaudePastedTextMarker } from './claudePastedTextMarker';
import { isClaudeUnifiedComposerTextMatch } from './promptIdentity';
import { parseClaudeScreenState } from './tuiControls/screenState';

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function isCollapsedPastedTextComposer(composerContent: string | null): boolean {
  return composerContent !== null
    && isExactClaudePastedTextMarker(composerContent);
}

function shouldVerifyAfterSubmit(promptText: string): boolean {
  return normalizeNewlines(promptText).trim().length > 0;
}

function isPromptInComposer(params: Readonly<{
  promptText: string;
  screenText: string;
}>): boolean {
  const state = parseClaudeScreenState(params.screenText);
  return isCollapsedPastedTextComposer(state.composerContent)
    || (state.composerContent !== null && isClaudeUnifiedComposerTextMatch({
      promptText: params.promptText,
      composerText: state.composerContent,
      // During this authorized paste, Claude may expose fewer than 256 characters
      // in a small viewport (observed with 2.1.280). Historical draft ownership
      // keeps its stronger threshold; submission must not depend on window size.
      allowShortVisibleWindow: true,
    }));
}

export function createClaudePromptSubmitVerificationPolicy(): TerminalPromptSubmitVerificationPolicy {
  return {
    shouldVerifyAfterSubmit,
    isPromptStagedBeforeSubmit: isPromptInComposer,
    isPromptStillPendingAfterSubmit: isPromptInComposer,
  };
}
