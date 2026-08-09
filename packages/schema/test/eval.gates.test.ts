/**
 * Promotion-gate evaluator tests (issue #24; PRD §7, TRD §15.3).
 *
 * Fixtures-only. The evidence objects are synthetic literals — the point under
 * test is the DECISION PROCEDURE: pre-registered thresholds, fail-closed on
 * missing evidence, CI-lower-bound rule for reductions, diagnostic-only
 * inadmissibility, and the per-cohort no-hidden-regression rule.
 */

import { describe, it, expect } from "vitest";
import {
  evaluatePromotion,
  PROMOTION_GATES,
  type PromotionEvidence,
  type RepresentationBenchmarkReport,
} from "@apature/ui-graph";

/** Minimal benchmark report literal with one b5 comparison. */
function reportWith(comparison: {
  available: boolean;
  diagnosticOnly?: boolean;
  lower: number;
  point: number;
}): RepresentationBenchmarkReport {
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
          ? [
              {
                metric: "text_tokens",
                reduction: {
                  point: comparison.point,
                  lower: comparison.lower,
                  upper: comparison.point + 0.05,
                  level: 0.95,
                  iterations: 300,
                  seed: 42,
                  pairs: 20,
                },
              },
            ]
          : undefined,
      },
    ],
    notes: [],
    contentHash: "sha256:" + "1".repeat(64),
  } as RepresentationBenchmarkReport;
}

const fullPassingEvidence = (): PromotionEvidence => ({
  benchmark: reportWith({ available: true, lower: 0.72, point: 0.78 }),
  candidate: "b5_focused_view",
  focusViewP95TextTokens: 1200,
  repeatedReviewCostReduction: 0.66,
  validRefRate: 0.999,
  grounding: {
    viewRecallAt1: 0.91,
    bestBaselineRecallAt1: 0.915,
    pairedDiscordant: { viewOnly: 6, baselineOnly: 8 },
  },
  crossSnapshotMatchPrecision: 0.987,
  coordTransformErrorCssPx: 1.4,
  viewportShorterSideCssPx: 900,
  deltaHashMatchRate: 1,
  findingQuality: {
    recallLossPp: 1.2,
    precisionLossPp: 0.4,
    blockerRecallRegressed: false,
    invalidRefIncrease: false,
  },
  security: {
    crossTenantResolutions: 0,
    redactionLeaks: 0,
    injectionSerializedAsData: true,
    malformedDeltaAccepted: false,
  },
  perCohort: [
    { cohort: "clean", textReduction: 0.8, findingRecallLossPp: 0.5 },
    { cohort: "dense", textReduction: 0.71, findingRecallLossPp: 1.9 },
    { cohort: "non_dom", textReduction: 0.65, findingRecallLossPp: 1.0 },
  ],
});

describe("evaluatePromotion (#24) — fail-closed decision procedure", () => {
  it("empty evidence: every gate is insufficient and promotion is refused", () => {
    const decision = evaluatePromotion({});
    expect(decision.promote).toBe(false);
    expect(decision.results.length).toBeGreaterThanOrEqual(10);
    for (const r of decision.results) {
      expect(r.status).toBe("insufficient_evidence");
    }
    expect(decision.summary).toContain("DO NOT PROMOTE");
  });

  it("complete passing evidence promotes, with the McNemar disclosure attached", () => {
    const decision = evaluatePromotion(fullPassingEvidence());
    expect(decision.results.every((r) => r.status === "pass")).toBe(true);
    expect(decision.promote).toBe(true);
    expect(decision.groundingMcNemar?.discordant).toBe(14);
    expect(decision.summary).toContain("PROMOTE");
  });

  it("token reduction passes on the CI LOWER bound, not the point estimate", () => {
    const evidence = {
      ...fullPassingEvidence(),
      benchmark: reportWith({ available: true, lower: 0.68, point: 0.75 }),
    };
    const decision = evaluatePromotion(evidence);
    const gate = decision.results.find((r) => r.gate === "token_reduction");
    expect(gate?.status).toBe("fail");
    expect(decision.promote).toBe(false);
  });

  it("diagnostic-only benchmark comparisons are inadmissible for PRD §7.1", () => {
    const evidence = {
      ...fullPassingEvidence(),
      benchmark: reportWith({ available: true, diagnosticOnly: true, lower: 0.9, point: 0.95 }),
    };
    const gate = evaluatePromotion(evidence).results.find((r) => r.gate === "token_reduction");
    expect(gate?.status).toBe("insufficient_evidence");
    expect(gate?.detail).toMatch(/diagnostic-only/);
  });

  it("a single hidden cohort regression fails promotion despite aggregate wins", () => {
    const evidence: PromotionEvidence = {
      ...fullPassingEvidence(),
      perCohort: [
        { cohort: "clean", textReduction: 0.85 },
        { cohort: "dense", textReduction: -0.05 },
      ],
    };
    const decision = evaluatePromotion(evidence);
    const gate = decision.results.find((r) => r.gate === "per_cohort_no_hidden_regression");
    expect(gate?.status).toBe("fail");
    expect(gate?.observed).toContain("dense");
    expect(decision.promote).toBe(false);
  });

  it("grounding loss beyond 1pp fails (PRD §7.2)", () => {
    const evidence: PromotionEvidence = {
      ...fullPassingEvidence(),
      grounding: { viewRecallAt1: 0.88, bestBaselineRecallAt1: 0.905 },
    };
    const gate = evaluatePromotion(evidence).results.find(
      (r) => r.gate === "grounding_recall_at_1",
    );
    expect(gate?.status).toBe("fail");
  });

  it("coordinate budget uses max(2px, 0.5% shorter side)", () => {
    // 900px shorter side ⇒ budget = max(2, 4.5) = 4.5 CSS px.
    const pass = evaluatePromotion({
      ...fullPassingEvidence(),
      coordTransformErrorCssPx: 4.2,
      viewportShorterSideCssPx: 900,
    }).results.find((r) => r.gate === "coord_transform_error");
    expect(pass?.status).toBe("pass");

    const fail = evaluatePromotion({
      ...fullPassingEvidence(),
      coordTransformErrorCssPx: 4.7,
      viewportShorterSideCssPx: 900,
    }).results.find((r) => r.gate === "coord_transform_error");
    expect(fail?.status).toBe("fail");
  });

  it("any security leak fails hard (PRD §7.5)", () => {
    const decision = evaluatePromotion({
      ...fullPassingEvidence(),
      security: {
        crossTenantResolutions: 0,
        redactionLeaks: 1,
        injectionSerializedAsData: true,
        malformedDeltaAccepted: false,
      },
    });
    expect(decision.results.find((r) => r.gate === "security")?.status).toBe("fail");
    expect(decision.promote).toBe(false);
  });

  it("pre-registered thresholds carry the PRD §7 values verbatim", () => {
    expect(PROMOTION_GATES.tokenReductionMin).toBe(0.7);
    expect(PROMOTION_GATES.focusViewP95TextTokensMax).toBe(1500);
    expect(PROMOTION_GATES.repeatedReviewCostReductionMin).toBe(0.6);
    expect(PROMOTION_GATES.validRefRateMin).toBe(0.995);
    expect(PROMOTION_GATES.crossSnapshotMatchPrecisionMin).toBe(0.98);
    expect(PROMOTION_GATES.deltaHashMatchRateMin).toBe(1);
    expect(PROMOTION_GATES.findingRecallMaxLossPp).toBe(2);
    expect(PROMOTION_GATES.findingPrecisionMaxLossPp).toBe(1);
  });
});
