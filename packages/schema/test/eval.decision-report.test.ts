/**
 * #24's decision artifact: explicit three-way verdict over the gate results
 * and a content-addressed, provenance-stamped report: the citable
 * precondition for leaving shadow.
 */
import { describe, expect, it } from "vitest";
import {
  buildDecisionReport,
  evaluatePromotion,
  promotionVerdict,
  type PromotionEvidence,
  type RepresentationBenchmarkReport,
} from "../src/index.js";

// Mirror the gate-test fixtures (kept local: test files do not import each other).
function reportWith(comparison: { available: boolean; diagnosticOnly?: boolean; lower: number; point: number }): RepresentationBenchmarkReport {
  return {
    schemaVersion: "1.0.0",
    manifestContentHash: "sha256:" + "0".repeat(64),
    profiles: {
      textTokenizer: { id: "model-native@test", kind: "model_native" },
      visualTokenizer: { id: "model-native@test", kind: "model_native" },
      cost: { id: "test", textInputUsdPerMTok: 1, imageInputUsdPerMTok: 1 },
    },
    options: { seed: 42, iterations: 300, baselineForReduction: "b0_full_raw" },
    fixtures: [],
    comparisons: [
      {
        candidate: "b5_focused_view",
        baseline: "b0_full_raw",
        available: comparison.available,
        ...(comparison.diagnosticOnly === true ? { diagnosticOnly: true } : {}),
        pairedFixtures: 20,
        reductions: comparison.available
          ? [{ metric: "text_tokens", reduction: { point: comparison.point, lower: comparison.lower, upper: comparison.point + 0.05, level: 0.95, iterations: 300, seed: 42, pairs: 20 } }]
          : undefined,
      },
    ],
    notes: [],
    contentHash: "sha256:" + "1".repeat(64),
  } as RepresentationBenchmarkReport;
}

const passingEvidence = (): PromotionEvidence => ({
  benchmark: reportWith({ available: true, lower: 0.72, point: 0.78 }),
  candidate: "b5_focused_view",
  focusViewP95TextTokens: 1200,
  repeatedReviewCostReduction: 0.66,
  validRefRate: 0.999,
  grounding: { viewRecallAt1: 0.91, bestBaselineRecallAt1: 0.915, pairedDiscordant: { viewOnly: 6, baselineOnly: 8 } },
  crossSnapshotMatchPrecision: 0.987,
  coordTransformErrorCssPx: 1.4,
  viewportShorterSideCssPx: 900,
  deltaHashMatchRate: 1,
  findingQuality: { recallLossPp: 1.2, precisionLossPp: 0.4, blockerRecallRegressed: false, invalidRefIncrease: false },
  security: { crossTenantResolutions: 0, redactionLeaks: 0, injectionSerializedAsData: true, malformedDeltaAccepted: false },
  perCohort: [
    { cohort: "clean", textReduction: 0.8, findingRecallLossPp: 0.5 },
    { cohort: "dense", textReduction: 0.71, findingRecallLossPp: 1.9 },
  ],
});

describe("decision report (#24)", () => {
  it("gate_met: every gate passed; report is content-addressed with full provenance", () => {
    const evidence = passingEvidence();
    const decision = evaluatePromotion(evidence);
    expect(decision.promote).toBe(true);
    const report = buildDecisionReport(evidence.benchmark!, decision);
    expect(report.verdict).toBe("gate_met");
    expect(report.reportContentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.provenance.manifestContentHash).toBe(evidence.benchmark!.manifestContentHash);
    expect(report.provenance.benchmarkContentHash).toBe(evidence.benchmark!.contentHash);
    expect(report.provenance.tokenAccountingProfiles.textTokenizer.id).toBe("model-native@test");
    expect(report.provenance.benchmarkOptions.seed).toBe(42);
    // Deterministic: same inputs → byte-identical artifact.
    expect(buildDecisionReport(evidence.benchmark!, decision)).toEqual(report);
  });

  it("gate_rejected: a failed gate on sufficient evidence is a rejection, not inconclusive", () => {
    const evidence = passingEvidence();
    evidence.security = { crossTenantResolutions: 1, redactionLeaks: 0, injectionSerializedAsData: true, malformedDeltaAccepted: false };
    const decision = evaluatePromotion(evidence);
    expect(promotionVerdict(decision)).toBe("gate_rejected");
    expect(buildDecisionReport(evidence.benchmark!, decision).verdict).toBe("gate_rejected");
  });

  it("inconclusive: missing evidence never reads as met OR rejected", () => {
    const evidence = passingEvidence();
    delete (evidence as { grounding?: unknown }).grounding; // one gate loses its evidence
    const decision = evaluatePromotion(evidence);
    expect(decision.promote).toBe(false);
    expect(promotionVerdict(decision)).toBe("inconclusive");
    const report = buildDecisionReport(evidence.benchmark!, decision);
    expect(report.verdict).toBe("inconclusive");
  });

  it("a single-cohort regression rejects even when aggregates pass (TRD §15.3, via the gate)", () => {
    const evidence = passingEvidence();
    evidence.perCohort = [
      { cohort: "clean", textReduction: 0.85, findingRecallLossPp: 0.1 },
      { cohort: "injection", textReduction: -0.05, findingRecallLossPp: 0.2 }, // hidden regression
    ];
    const decision = evaluatePromotion(evidence);
    expect(promotionVerdict(decision)).toBe("gate_rejected");
  });
});
