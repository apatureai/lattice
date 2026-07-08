import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  IDENTITY,
  MAX_COORD,
  checkRect,
  compose,
  isInBounds,
  isValidAffine,
  rectsWithinTolerance,
  transformRect,
  translateRect,
  withinTolerance,
  type Affine,
  type Rect,
} from "@apature/ui-graph";

/**
 * Property-based laws for the pure affine geometry kernel (TRD §7, §8.2).
 *
 * Every property uses bounded finite generators (|x| ≤ 1e6) except where a law
 * is explicitly about non-finite / out-of-bounds classification. Composed
 * float results are compared with a relative tolerance, never exact equality;
 * exact comparison is reserved for laws where the arithmetic is provably
 * identical (same ops in the same order).
 */

const EPS = 1e-6;

const coord = (mag: number) =>
  fc.double({ noNaN: true, noDefaultInfinity: true, min: -mag, max: mag });

const nonNegative = (mag: number) =>
  fc.double({ noNaN: true, noDefaultInfinity: true, min: 0, max: mag });

/** Any double, including NaN and ±Infinity — for classification laws only. */
const anyDouble = fc.double();

const arbAffine: fc.Arbitrary<Affine> = fc.tuple(
  coord(1e3),
  coord(1e3),
  coord(1e3),
  coord(1e3),
  coord(1e6),
  coord(1e6),
);

/**
 * Tamer magnitudes (coefficients ≤ 10, translations ≤ 1e4) for tolerance-based
 * laws: intermediate products stay ≤ ~1e6 so even fully cancelling sums leave
 * absolute error orders of magnitude below EPS. The broad `arbAffine` is
 * reserved for laws asserting exact agreement, where magnitude is free.
 */
const arbTameAffine: fc.Arbitrary<Affine> = fc.tuple(
  coord(10),
  coord(10),
  coord(10),
  coord(10),
  coord(1e4),
  coord(1e4),
);

/**
 * Well-conditioned invertible affines: modest coefficients and a determinant
 * bounded away from zero so the analytic inverse does not amplify rounding
 * error past the test tolerance.
 */
const arbInvertible: fc.Arbitrary<Affine> = fc
  .tuple(coord(10), coord(10), coord(10), coord(10), coord(1e3), coord(1e3))
  .filter(([a, b, c, d]) => Math.abs(a * d - b * c) >= 0.1);

/** Axis-aligned (no rotation/skew: b = c = 0) — the case where transformRect is exact. */
const arbAxisAligned: fc.Arbitrary<Affine> = fc
  .tuple(coord(1e2), coord(1e2), coord(1e2), coord(1e2))
  .map(([a, d, e, f]) => [a, 0, 0, d, e, f]);

const rectWithin = (mag: number): fc.Arbitrary<Rect> =>
  fc.record({ x: coord(mag), y: coord(mag), width: nonNegative(mag), height: nonNegative(mag) });

const arbRect = rectWithin(1e6);

/** Analytic inverse of an invertible affine 6-tuple. */
function inverse([a, b, c, d, e, f]: Affine): Affine {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function approx(actual: number, expected: number, eps = EPS): boolean {
  return Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(actual), Math.abs(expected));
}

function expectApproxNumbers(actual: readonly number[], expected: readonly number[], eps = EPS): void {
  actual.forEach((v, i) => {
    if (!approx(v, expected[i], eps)) {
      expect.fail(`component ${i}: ${v} !~ ${expected[i]} (eps=${eps})`);
    }
  });
}

function expectApproxRect(actual: Rect, expected: Rect, eps = EPS): void {
  expectApproxNumbers(
    [actual.x, actual.y, actual.width, actual.height],
    [expected.x, expected.y, expected.width, expected.height],
    eps,
  );
}

/** Exact componentwise equality under `===` (so +0 and -0 are interchangeable). */
function expectSameNumbers(actual: readonly number[], expected: readonly number[]): void {
  actual.forEach((v, i) => {
    if (v !== expected[i]) {
      expect.fail(`component ${i}: ${v} !== ${expected[i]}`);
    }
  });
}

describe("geometry property laws", () => {
  it("IDENTITY is a two-sided unit for compose (exact up to zero sign)", () => {
    fc.assert(
      fc.property(arbAffine, (t) => {
        expectSameNumbers(compose(IDENTITY, t), t);
        expectSameNumbers(compose(t, IDENTITY), t);
      }),
    );
  });

  it("compose is associative within float tolerance", () => {
    fc.assert(
      fc.property(arbTameAffine, arbTameAffine, arbTameAffine, (t1, t2, t3) => {
        expectApproxNumbers(compose(compose(t1, t2), t3), compose(t1, compose(t2, t3)));
      }),
    );
  });

  it("compose(t, inverse(t)) ≈ IDENTITY for well-conditioned t", () => {
    fc.assert(
      fc.property(arbInvertible, (t) => {
        expectApproxNumbers(compose(t, inverse(t)), IDENTITY);
        expectApproxNumbers(compose(inverse(t), t), IDENTITY);
      }),
    );
  });

  it("transformRect(IDENTITY) fixes position exactly and extents within tolerance", () => {
    fc.assert(
      fc.property(arbRect, (r) => {
        const out = transformRect(IDENTITY, r);
        // x/y map through 1·x + 0·y + 0 and stay exact; width is recovered as
        // (x + width) − x, which reintroduces one rounding step.
        expectSameNumbers([out.x, out.y], [r.x, r.y]);
        expectApproxNumbers([out.width, out.height], [r.width, r.height]);
      }),
    );
  });

  it("transformRect equals the AABB of the four corner points mapped directly", () => {
    fc.assert(
      fc.property(arbAffine, rectWithin(1e3), ([a, b, c, d, e, f], r) => {
        const corners: Array<[number, number]> = [
          [r.x, r.y],
          [r.x + r.width, r.y],
          [r.x, r.y + r.height],
          [r.x + r.width, r.y + r.height],
        ].map(([x, y]): [number, number] => [a * x + c * y + e, b * x + d * y + f]);
        const xs = corners.map(([px]) => px);
        const ys = corners.map(([, py]) => py);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const expected: Rect = {
          x: minX,
          y: minY,
          width: Math.max(...xs) - minX,
          height: Math.max(...ys) - minY,
        };
        const out = transformRect([a, b, c, d, e, f], r);
        // Same arithmetic in the same order — exact agreement is required.
        expectSameNumbers(
          [out.x, out.y, out.width, out.height],
          [expected.x, expected.y, expected.width, expected.height],
        );
      }),
    );
  });

  it("transformRect is functorial over compose for axis-aligned transforms", () => {
    // Only claimed without rotation/skew: under rotation the AABB of an AABB
    // legitimately over-covers, so the two sides differ by design.
    fc.assert(
      fc.property(arbAxisAligned, arbAxisAligned, rectWithin(1e3), (outer, inner, r) => {
        expectApproxRect(transformRect(compose(outer, inner), r), transformRect(outer, transformRect(inner, r)));
      }),
    );
  });

  it("zero-extent rects behave as points: round-trip through inverse recovers them", () => {
    // A width=0/height=0 rect maps all four corners to one point, so the AABB
    // over-coverage of rotated rects cannot occur and t⁻¹∘t ≈ id holds.
    fc.assert(
      fc.property(arbInvertible, coord(1e3), coord(1e3), (t, x, y) => {
        const point: Rect = { x, y, width: 0, height: 0 };
        expectApproxRect(transformRect(inverse(t), transformRect(t, point)), point);
      }),
    );
  });

  it("transformRect never produces negative extents and preserves zero extent", () => {
    fc.assert(
      fc.property(arbAffine, arbRect, (t, r) => {
        const out = transformRect(t, r);
        expect(out.width).toBeGreaterThanOrEqual(0);
        expect(out.height).toBeGreaterThanOrEqual(0);
        const point = transformRect(t, { x: r.x, y: r.y, width: 0, height: 0 });
        expectSameNumbers([point.width, point.height], [0, 0]);
      }),
    );
  });

  it("a fully singular transform collapses every rect to its translation point", () => {
    fc.assert(
      fc.property(coord(1e6), coord(1e6), arbRect, (e, f, r) => {
        const out = transformRect([0, 0, 0, 0, e, f], r);
        expectSameNumbers([out.x, out.y, out.width, out.height], [e, f, 0, 0]);
      }),
    );
  });

  it("translateRect preserves extents exactly, is undone by the negated offset, and is trivial at (0,0)", () => {
    fc.assert(
      fc.property(arbRect, coord(1e6), coord(1e6), (r, dx, dy) => {
        const moved = translateRect(r, dx, dy);
        expectSameNumbers([moved.width, moved.height], [r.width, r.height]);
        expectApproxRect(translateRect(moved, -dx, -dy), r);
        const still = translateRect(r, 0, 0);
        expectSameNumbers([still.x, still.y, still.width, still.height], [r.x, r.y, r.width, r.height]);
      }),
    );
  });

  it("withinTolerance is reflexive, accepts the 2px floor, and is monotone in distance from the reference", () => {
    fc.assert(
      // |delta| ≤ 1.99 keeps a wide margin under the 2px floor even after the
      // ref + delta rounding step (≤ ~1e-10 at |ref| ≤ 1e6).
      fc.property(coord(1e6), coord(1.99), (ref, delta) => {
        expect(withinTolerance(ref, ref)).toBe(true);
        expect(withinTolerance(ref + delta, ref)).toBe(true);
      }),
    );
    fc.assert(
      // Compare the realized float distances (the exact quantity the predicate
      // tests) so rounding in ref + d cannot reorder near/far.
      fc.property(coord(1e6), coord(1e6), coord(1e6), (ref, d1, d2) => {
        const a1 = ref + d1;
        const a2 = ref + d2;
        const [near, far] = Math.abs(a1 - ref) <= Math.abs(a2 - ref) ? [a1, a2] : [a2, a1];
        if (withinTolerance(far, ref)) {
          expect(withinTolerance(near, ref)).toBe(true);
        }
      }),
    );
  });

  it("rectsWithinTolerance is reflexive and tolerates sub-floor perturbation of every component", () => {
    fc.assert(
      fc.property(arbRect, coord(1), coord(1), (r, jx, jy) => {
        expect(rectsWithinTolerance(r, r)).toBe(true);
        const jittered = translateRect(r, jx, jy);
        expect(rectsWithinTolerance(jittered, r)).toBe(true);
        expect(rectsWithinTolerance(r, jittered)).toBe(true);
      }),
    );
  });

  it("checkRect classifies every rect: non-finite/negative-extent → non_finite, then overflow, else ok", () => {
    const arbAnyRect = fc.record({ x: anyDouble, y: anyDouble, width: anyDouble, height: anyDouble });
    fc.assert(
      fc.property(arbAnyRect, (r) => {
        const fields = [r.x, r.y, r.width, r.height];
        const result = checkRect(r);
        if (fields.some((v) => !Number.isFinite(v)) || r.width < 0 || r.height < 0) {
          // Negative extents are deliberately folded into "non_finite" (they are
          // rejected before overflow is ever considered) — pinned behavior.
          expect(result).toStrictEqual({ ok: false, reason: "non_finite" });
        } else if (fields.some((v) => Math.abs(v) > MAX_COORD)) {
          expect(result).toStrictEqual({ ok: false, reason: "overflow" });
        } else {
          expect(result).toStrictEqual({ ok: true });
        }
      }),
    );
  });

  it("isValidAffine bounds only the translation pair and rejects non-finite or mis-sized tuples", () => {
    fc.assert(
      fc.property(fc.array(anyDouble, { minLength: 0, maxLength: 8 }), (t) => {
        const expected =
          t.length === 6 &&
          t.every((n) => Number.isFinite(n)) &&
          isInBounds(t[4] as number) &&
          isInBounds(t[5] as number);
        expect(isValidAffine(t)).toBe(expected);
      }),
    );
    fc.assert(
      fc.property(fc.tuple(anyDouble, anyDouble, anyDouble, anyDouble), coord(MAX_COORD), coord(MAX_COORD), (scales, e, f) => {
        const finiteScales = scales.every((n) => Number.isFinite(n));
        // Arbitrarily large-but-finite scale/skew never invalidates the tuple.
        expect(isValidAffine([...scales, e, f])).toBe(finiteScales);
      }),
    );
  });

  it("compose and transformRect are deterministic (repeated calls are bit-identical)", () => {
    fc.assert(
      fc.property(arbAffine, arbAffine, arbRect, (t1, t2, r) => {
        const c1 = compose(t1, t2);
        const c2 = compose(t1, t2);
        c1.forEach((v, i) => expect(Object.is(v, c2[i])).toBe(true));
        const r1 = transformRect(t1, r);
        const r2 = transformRect(t1, r);
        for (const k of ["x", "y", "width", "height"] as const) {
          expect(Object.is(r1[k], r2[k])).toBe(true);
        }
      }),
    );
  });
});
