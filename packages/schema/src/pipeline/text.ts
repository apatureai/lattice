/**
 * Deterministic text normalization for matching (TRD §8.2).
 *
 * Matching needs a stable key (NFC, collapsed whitespace, case-folded) but the
 * *display* text, which may be redacted, must be preserved separately so the
 * normalized key is never shown and the redaction boundary is never crossed.
 */

export interface NormalizedText {
  /** Display text exactly as supplied (possibly already redacted upstream). */
  readonly display: string;
  /** Stable key for matching: NFC, whitespace-collapsed, trimmed, case-folded. */
  readonly matchKey: string;
  readonly redacted: boolean;
}

/**
 * Whitespace collapsed to a single space. `\s` already covers NBSP (U+00A0);
 * the explicit code points add zero-width separators (ZWSP/ZWNJ/ZWJ/BOM) which
 * are not whitespace but must not survive in a match key. Built via `RegExp`
 * from escapes so the source carries no irregular characters.
 */
const WHITESPACE = new RegExp("(?:\\s|\\u200b|\\u200c|\\u200d|\\ufeff)+", "gu");

export function normalizeMatchText(display: string, redacted = false): NormalizedText {
  const key = display.normalize("NFC").replace(WHITESPACE, " ").trim().toLowerCase();
  // A redacted run never contributes its content to the match key.
  return { display, matchKey: redacted ? "" : key, redacted };
}
