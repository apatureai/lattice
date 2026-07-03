/**
 * Deterministic 2D affine geometry (TRD §7, §8.2).
 *
 * Frame transforms are CSS `matrix(a,b,c,d,e,f)` 6-tuples mapping a point
 * `(x, y)` to `(a·x + c·y + e, b·x + d·y + f)`. Composing a frame's transform up
 * through its parents flattens nested frames into document and viewport
 * coordinate spaces. All operations are pure and read no clock/locale/RNG.
 */

import type { Rect } from "../types.js";

/** CSS affine 6-tuple: [a, b, c, d, e, f]. */
export type Affine = [number, number, number, number, number, number];

/** Identity transform (a=d=1, everything else 0). */
export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/**
 * Maximum absolute coordinate magnitude. Beyond this a value is treated as an
 * overflow attack / corrupt input rather than a real layout coordinate (a
 * 16M-CSS-px page is already two orders of magnitude past any real viewport).
 */
export const MAX_COORD = 1e7;

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** True when `value` is finite and within the legal coordinate magnitude. */
export function isInBounds(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_COORD;
}

/** Validate an affine 6-tuple: all finite, translation within bounds. */
export function isValidAffine(t: readonly number[]): t is Affine {
  if (t.length !== 6) return false;
  for (const n of t) {
    if (!Number.isFinite(n)) return false;
  }
  // Translation components must be in-bounds; scale/skew may be small fractions.
  return isInBounds(t[4] as number) && isInBounds(t[5] as number);
}

/**
 * Compose two transforms so that applying the result equals applying `inner`
 * then `outer` (outer ∘ inner). Used to fold a frame→parent transform into a
 * parent→document transform.
 */
export function compose(outer: Affine, inner: Affine): Affine {
  const [a1, b1, c1, d1, e1, f1] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function applyPoint(t: Affine, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = t;
  return [a * x + c * y + e, b * x + d * y + f];
}

/**
 * Transform an axis-aligned rect by an affine transform, returning the
 * axis-aligned bounding box of the four mapped corners (correct even under
 * rotation/skew; exact for the translation/scale case).
 */
export function transformRect(t: Affine, rect: Rect): Rect {
  const corners: Array<[number, number]> = [
    applyPoint(t, rect.x, rect.y),
    applyPoint(t, rect.x + rect.width, rect.y),
    applyPoint(t, rect.x, rect.y + rect.height),
    applyPoint(t, rect.x + rect.width, rect.y + rect.height),
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of corners) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Translate a rect (used for document→viewport via the negated scroll offset). */
export function translateRect(rect: Rect, dx: number, dy: number): Rect {
  return { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
}

/**
 * Composition tolerance (PRD §7.2): two coordinates agree when they differ by at
 * most 2 CSS px or 0.5% of the reference magnitude, whichever is larger.
 */
export function withinTolerance(actual: number, reference: number): boolean {
  const allowed = Math.max(2, Math.abs(reference) * 0.005);
  return Math.abs(actual - reference) <= allowed;
}

/** True when every component of two rects agrees within tolerance. */
export function rectsWithinTolerance(a: Rect, b: Rect): boolean {
  return (
    withinTolerance(a.x, b.x) &&
    withinTolerance(a.y, b.y) &&
    withinTolerance(a.width, b.width) &&
    withinTolerance(a.height, b.height)
  );
}

export type RectCheck = { ok: true } | { ok: false; reason: "non_finite" | "overflow" };

/** Reject NaN/Infinity, negative extents, and overflow before any normalization. */
export function checkRect(rect: Rect): RectCheck {
  const fields = [rect.x, rect.y, rect.width, rect.height];
  for (const v of fields) {
    if (!Number.isFinite(v)) return { ok: false, reason: "non_finite" };
  }
  if (rect.width < 0 || rect.height < 0) return { ok: false, reason: "non_finite" };
  for (const v of fields) {
    if (Math.abs(v) > MAX_COORD) return { ok: false, reason: "overflow" };
  }
  return { ok: true };
}
