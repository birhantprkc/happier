/**
 * Claude records a bracketed-paste prompt wrapped in its own paste markers, each on its own line:
 *
 *   <pasted_content id="9b65">
 *   …the pasted text…
 *   </pasted_content id="9b65">
 *
 * The closing marker repeats the id, so this is not XML. The markers describe how the text
 * reached the composer, never what the prompt says, so prompt identity is the unwrapped text on
 * both sides of the terminal round-trip. Observed on Claude Code 2.1.259 (live incident
 * 2026-09-18, session cmtyf86rp1a1ttm237czmr4ts): without this, every multi-line prompt Happier
 * pastes reads back as different text, so provider acceptance never correlates and the delivered
 * message stays "delivering" forever.
 */
const CLAUDE_PASTED_CONTENT_MARKER_LINE = /^<\/?pasted_content id="[^"]*">$/;

export function normalizeClaudeUnifiedPromptIdentityText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !CLAUDE_PASTED_CONTENT_MARKER_LINE.test(line))
    .join('\n')
    .trim();
}

/**
 * Claude may render one logical composer value across several terminal rows. Treat those visual
 * whitespace breaks as presentation only while retaining the exact normalized word sequence.
 */
export function normalizeClaudeUnifiedComposerRenderingText(value: string): string {
  return normalizeClaudeUnifiedPromptIdentityText(value).replace(/\s+/g, ' ');
}

export const CLAUDE_UNIFIED_LONG_COMPOSER_RESIDUE_MIN_CHARS = 256;

/**
 * Match the complete logical composer text, or a sufficiently long visible window when Claude's
 * terminal viewport exposes only part of a longer draft. The cursor may leave that window at the
 * beginning, middle, or end of the prompt. Both sides use the same soft-wrap-insensitive identity
 * so terminal row wrapping is presentation, not prompt content.
 */
export function isClaudeUnifiedComposerTextMatch(params: Readonly<{
  promptText: string;
  composerText: string;
  minPrefixChars?: number | undefined;
}>): boolean {
  const promptText = normalizeClaudeUnifiedComposerRenderingText(params.promptText);
  const composerText = normalizeClaudeUnifiedComposerRenderingText(params.composerText);
  if (!promptText || !composerText) return false;
  if (composerText === promptText) return true;

  const minPrefixChars = Math.max(
    1,
    Math.trunc(params.minPrefixChars ?? CLAUDE_UNIFIED_LONG_COMPOSER_RESIDUE_MIN_CHARS),
  );
  if (
    composerText.length >= CLAUDE_UNIFIED_LONG_COMPOSER_RESIDUE_MIN_CHARS
    && promptText.length > composerText.length
    && promptText.includes(composerText)
  ) {
    return true;
  }

  // Only the evidence-backed long viewport window may occur in the middle or at the end. Keep
  // explicitly authorized short possible-write residues prefix-only so a genuine user draft that
  // merely shares a short phrase with an earlier injection is never treated as controller-owned.
  return composerText.length >= minPrefixChars
    && promptText.length > composerText.length
    && promptText.startsWith(composerText);
}
