/**
 * Offline representation benchmark tests (issue #20; TRD §15.1, PRD §9 R1).
 *
 * Fixtures-only: the runner is exercised over the frozen manifest (#19) and the
 * golden capture read-profiles (issue #3). No model, browser, or network. The
 * token counters are the labeled offline estimators, and the tests assert the
 * runner's honesty properties (determinism, fail-closed B5, diagnostic-only
 * B4) rather than any model quality claim.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  REPRESENTATION_MANIFEST,
  runRepresentationBenchmark,
  renderBenchmarkMarkdown,
  type CaptureBundleReadProfile,
  type CaptureResolver,
  type RepresentationBenchmarkReport,
} from "@apature/ui-graph";

const loadCapture = (rel: string): CaptureBundleReadProfile =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)), "utf8"),
  ) as CaptureBundleReadProfile;

const resolver: CaptureResolver = {
  resolve: (ref) => loadCapture(ref),
};

const run = (): RepresentationBenchmarkReport =>
  runRepresentationBenchmark(REPRESENTATION_MANIFEST, resolver, { iterations: 300, seed: 42 });

describe("runRepresentationBenchmark (#20)", () => {
  const report = run();

  it("is deterministic: two runs produce byte-identical reports", () => {
    const again = run();
    expect(again.contentHash).toBe(report.contentHash);
    expect(again).toEqual(report);
  });

  it("pins the frozen manifest it measured against", () => {
    expect(report.manifestContentHash).toBe(REPRESENTATION_MANIFEST.manifestContentHash);
  });

  it("measures every manifest fixture across all six baselines", () => {
    const manifestCount = REPRESENTATION_MANIFEST.sets.reduce(
      (n, s) => n + s.fixtures.length,
      0,
    );
    expect(report.fixtures).toHaveLength(manifestCount);
    for (const fixture of report.fixtures) {
      expect(fixture.measurements.map((m) => m.baseline)).toEqual([
        "b0_full_raw",
        "b1_ax_only",
        "b2_screenshot_only",
        "b3_screenshot_ax",
        "b4_full_graph",
        "b5_focused_view",
      ]);
    }
  });

  it("records the token-accounting profiles and labels them estimates", () => {
    expect(report.profiles.textTokenizer.kind).toBe("estimate");
    expect(report.profiles.visualTokenizer.kind).toBe("estimate");
  });

  it("AX-only (B1) always costs fewer text tokens than full raw (B0)", () => {
    for (const fixture of report.fixtures) {
      const b0 = fixture.measurements.find((m) => m.baseline === "b0_full_raw");
      const b1 = fixture.measurements.find((m) => m.baseline === "b1_ax_only");
      expect(b0?.available).toBe(true);
      expect(b1?.available).toBe(true);
      expect((b1?.textTokens ?? Infinity) < (b0?.textTokens ?? 0)).toBe(true);
    }
  });

  it("screenshot-only (B2) carries image tokens, not text bulk", () => {
    for (const fixture of report.fixtures) {
      const b2 = fixture.measurements.find((m) => m.baseline === "b2_screenshot_only");
      expect(b2?.available).toBe(true);
      expect(b2?.textTokens ?? Infinity).toBeLessThan(64);
    }
  });

  it("B5 renders the focused view (#41): available, non-empty, text-only", () => {
    for (const fixture of report.fixtures) {
      const b5 = fixture.measurements.find((m) => m.baseline === "b5_focused_view");
      expect(b5?.available).toBe(true);
      expect(b5?.reason).toBeUndefined();
      expect(b5?.textTokens ?? 0).toBeGreaterThan(0);
      expect(b5?.imageTokens ?? 1).toBe(0);
      // Token-REDUCTION claims (B5 vs B4/B0) are a property of real page
      // sizes: on these tiny synthetic fixtures the whole graph fits inside
      // the focus radius, so ratios are meaningless here. The R1 corpus run
      // (#20) is where reduction is measured; this test pins only that the
      // renderer produces a real, deterministic measurement.
    }
  });

  it("B4 is marked diagnostic-only while the sealed-snapshot assembler is missing", () => {
    const b4s = report.fixtures.flatMap((f) =>
      f.measurements.filter((m) => m.baseline === "b4_full_graph" && m.available),
    );
    expect(b4s.length).toBeGreaterThan(0);
    for (const m of b4s) expect(m.diagnosticOnly).toBe(true);
    const comparison = report.comparisons.find((c) => c.candidate === "b4_full_graph");
    expect(comparison?.diagnosticOnly).toBe(true);
  });

  it("computes TRD §15.1 reductions with bootstrap CIs for available candidates", () => {
    const b1 = report.comparisons.find((c) => c.candidate === "b1_ax_only");
    expect(b1?.available).toBe(true);
    const text = b1?.reductions?.find((r) => r.metric === "text_tokens");
    expect(text).toBeDefined();
    if (text === undefined) return;
    expect(text.reduction.point).toBeGreaterThan(0);
    expect(text.reduction.lower).toBeLessThanOrEqual(text.reduction.point);
    expect(text.reduction.upper).toBeGreaterThanOrEqual(text.reduction.point);
    expect(text.reduction.level).toBe(0.95);
  });

  it("publishes per-cohort reductions so aggregates cannot mask a cohort regression", () => {
    const b1 = report.comparisons.find((c) => c.candidate === "b1_ax_only");
    expect(b1?.perCohort?.length ?? 0).toBeGreaterThan(0);
    const cohorts = (b1?.perCohort ?? []).map((c) => c.cohort);
    expect(cohorts).toContain("clean");
    for (const c of b1?.perCohort ?? []) {
      expect(c.pairedFixtures).toBeGreaterThan(0);
    }
  });

  it("the B5 candidate now yields a real comparison (#41 unblocked #20's B5 rows)", () => {
    const b5 = report.comparisons.find((c) => c.candidate === "b5_focused_view");
    expect(b5?.available).toBe(true);
    expect(b5?.pairedFixtures).toBeGreaterThan(0);
  });

  it("renders deterministic, timestamp-free markdown", () => {
    const md = renderBenchmarkMarkdown(report);
    expect(md).toBe(renderBenchmarkMarkdown(run()));
    expect(md).toContain(report.manifestContentHash.slice(0, 12));
    expect(md).toContain("text_reduction");
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
