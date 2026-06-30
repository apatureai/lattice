/**
 * Deterministic CSS numeric normalization (TRD §8.2).
 *
 * Lengths are normalized to CSS pixels for absolute units; the original token is
 * preserved by the caller. Relative/unknown units (`em`, `%`, …) cannot be
 * resolved without layout context, so they normalize to `valueCssPx: null` with
 * the parsed unit retained — never silently coerced to a bogus pixel value.
 */

import { isInBounds } from "./geometry.js";

export interface NormalizedLength {
  readonly original: string | number;
  readonly valueCssPx: number | null;
  readonly unit: string | null;
}

/** Absolute CSS units expressible as a fixed multiple of a pixel (CSS spec). */
const ABSOLUTE_PX: Record<string, number> = {
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 25.4 / 4,
  pt: 96 / 72,
  pc: 16,
};

const NUMERIC = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i;

export function normalizeCssLength(input: string | number): NormalizedLength {
  if (typeof input === "number") {
    const ok = Number.isFinite(input) && isInBounds(input);
    return { original: input, valueCssPx: ok ? input : null, unit: ok ? "px" : null };
  }

  const value = input.trim().toLowerCase();
  const m = NUMERIC.exec(value);
  if (!m) return { original: input, valueCssPx: null, unit: null };

  const magnitude = Number(m[1]);
  const unit = m[2] === "" ? "px" : (m[2] as string);
  if (!Number.isFinite(magnitude)) return { original: input, valueCssPx: null, unit };

  const factor = ABSOLUTE_PX[unit];
  if (factor === undefined) {
    // Relative or unknown unit: keep the unit, do not invent a pixel value.
    return { original: input, valueCssPx: null, unit };
  }

  const px = magnitude * factor;
  return { original: input, valueCssPx: isInBounds(px) ? px : null, unit: "px" };
}
