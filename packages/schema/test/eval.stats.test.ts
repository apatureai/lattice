/**
 * Deterministic statistics tests (#20; TRD §15.1).
 *
 * Fixtures-only: pure math over literal inputs. McNemar cases are checked
 * against hand-computed exact binomial values; the bootstrap is checked for
 * determinism (same seed ⇒ identical interval) and sanity, never against a
 * random baseline.
 */

import { describe, it, expect } from "vitest";
import { mcnemarExact, mulberry32, pairedBootstrapCI } from "@apature/ui-graph";

describe("mcnemarExact (paired binary outcomes)", () => {
  it("matches the hand-computed exact two-sided value for (5,1)", () => {
    // n=6, k=1: p = 2 * (C(6,0)+C(6,1)) / 2^6 = 2 * 7/64 = 0.21875
    const r = mcnemarExact(5, 1);
    expect(r.discordant).toBe(6);
    expect(r.pValue).toBeCloseTo(0.21875, 10);
  });

  it("matches the hand-computed value for a one-sided sweep (10,0)", () => {
    // n=10, k=0: p = 2 * 1/1024 = 0.001953125
    expect(mcnemarExact(10, 0).pValue).toBeCloseTo(0.001953125, 12);
  });

  it("is symmetric in its arguments", () => {
    expect(mcnemarExact(3, 8).pValue).toBeCloseTo(mcnemarExact(8, 3).pValue, 12);
  });

  it("returns p=1 with no discordant pairs (representations indistinguishable)", () => {
    expect(mcnemarExact(0, 0)).toEqual({ pValue: 1, discordant: 0, aOnly: 0, bOnly: 0 });
  });

  it("never exceeds 1 for balanced discordance", () => {
    expect(mcnemarExact(4, 4).pValue).toBeLessThanOrEqual(1);
  });

  it("rejects negative or fractional counts", () => {
    expect(() => mcnemarExact(-1, 2)).toThrow();
    expect(() => mcnemarExact(1.5, 2)).toThrow();
  });
});

describe("pairedBootstrapCI (seeded percentile bootstrap)", () => {
  const pairs = [
    { base: 100, cand: 30 },
    { base: 200, cand: 55 },
    { base: 150, cand: 40 },
    { base: 300, cand: 100 },
    { base: 120, cand: 35 },
  ];
  const reduction = (sample: readonly { base: number; cand: number }[]): number => {
    let b = 0;
    let c = 0;
    for (const p of sample) {
      b += p.base;
      c += p.cand;
    }
    return b <= 0 ? 0 : 1 - c / b;
  };

  it("is deterministic for the same seed", () => {
    const a = pairedBootstrapCI(pairs, reduction, { seed: 7, iterations: 500 });
    const b = pairedBootstrapCI(pairs, reduction, { seed: 7, iterations: 500 });
    expect(a).toEqual(b);
  });

  it("changes replicates (but not the point) under a different seed", () => {
    const a = pairedBootstrapCI(pairs, reduction, { seed: 7, iterations: 500 });
    const b = pairedBootstrapCI(pairs, reduction, { seed: 8, iterations: 500 });
    expect(a.point).toBe(b.point);
    expect(a.lower === b.lower && a.upper === b.upper).toBe(false);
  });

  it("brackets the point estimate and orders the bounds", () => {
    const ci = pairedBootstrapCI(pairs, reduction, { seed: 42, iterations: 1000 });
    expect(ci.lower).toBeLessThanOrEqual(ci.point);
    expect(ci.upper).toBeGreaterThanOrEqual(ci.point);
    expect(ci.point).toBeCloseTo(reduction(pairs), 12);
  });

  it("collapses to the point for a degenerate constant sample", () => {
    const constant = [
      { base: 10, cand: 5 },
      { base: 10, cand: 5 },
      { base: 10, cand: 5 },
    ];
    const ci = pairedBootstrapCI(constant, reduction, { seed: 1, iterations: 200 });
    expect(ci.lower).toBeCloseTo(0.5, 12);
    expect(ci.upper).toBeCloseTo(0.5, 12);
  });

  it("rejects an empty sample", () => {
    expect(() => pairedBootstrapCI([], reduction)).toThrow();
  });
});

describe("mulberry32", () => {
  it("is deterministic and stays in [0,1)", () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 100; i++) {
      const va = a();
      expect(va).toBe(b());
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(1);
    }
  });
});
