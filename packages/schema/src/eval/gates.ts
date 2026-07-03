/**
 * Promotion-gate evaluator (issue #24; PRD §7, TRD §15.3; core #103 DECISION 4).
 *
 * Core #103 keeps UI Graph a feature-flagged experiment "until it proves
 * precision, grounding, fix-rate, cost, or latency value." This module turns
 * that sentence into a machine-checkable decision procedure with the PRD §7
 * numbers PRE-REGISTERED as constants — the pass/fail rule is frozen before any
 * result exists, so nobody (human or agent) can move the goalposts after seeing
 * the data.
 *
 * Decision rules:
 *  - FAIL-CLOSED: a gate with missing evidence is `insufficient_evidence`, and
 *    the overall decision cannot be `promote` unless EVERY gate passes.
 *  - Statistical, not point-estimate, where the TRD demands intervals: the
 *    token/cost reductions pass only if the LOWER bound of their 95% bootstrap
 *    CI clears the threshold (TRD §15.1), so a promotion cannot ride on a
 *    lucky resample.
 *  - Diagnostic-only benchmark rows (the pre-assembler B4 composite) are NOT
 *    admissible for PRD §7.1 — the gate demands measurements of the real
 *    serialized artifact.
 *  - Per-cohort disclosure is itself gated (TRD §15.3): aggregate wins with a
 *    hidden cohort regression do not promote.
 *
 * Model-dependent evidence (grounding, finding quality, latency, security
 * fixtures) is produced by Judgment Engine's eval runs and supplied here as
 * data. This module never invents a measurement.
 */

import type { EvalCohort } from "./manifest.js";
import type { BaselineComparison, BaselineId, RepresentationBenchmarkReport } from "./benchmark.js";
import { mcnemarExact, type McNemarResult } from "./stats.js";

// --- Pre-registered thresholds (PRD §7, verbatim) ---------------------------

export const PROMOTION_GATES = {
  /** PRD §7.1: ≥70% total model-input token reduction vs the screenshot+raw baseline. */
  tokenReductionMin: 0.7,
  /** PRD §7.1: `focus` view p95 ≤ 1,500 text tokens before optional image evidence. */
  focusViewP95TextTokensMax: 1500,
  /** PRD §7.1: ≥60% reduction in repeated-review input cost on snapshot reuse. */
  repeatedReviewCostReductionMin: 0.6,
  /** PRD §7.2: snapshot-local valid-reference rate ≥ 99.5%. */
  validRefRateMin: 0.995,
  /** PRD §7.2: grounding Recall@1 no worse than best baseline by >1 percentage point. */
  groundingRecallMaxLossPp: 1,
  /** PRD §7.2: high-confidence cross-snapshot match precision ≥ 98%. */
  crossSnapshotMatchPrecisionMin: 0.98,
  /** PRD §7.2: crop/overlay transform error ≤ 2 CSS px or 0.5% of shorter viewport side. */
  coordTransformErrorMaxCssPx: 2,
  coordTransformErrorMaxViewportFrac: 0.005,
  /** PRD §7.2: delta reconstruction hash match at 100% for valid deltas. */
  deltaHashMatchRateMin: 1,
  /** PRD §7.3: ≤2pp finding-recall loss and ≤1pp precision loss vs full context. */
  findingRecallMaxLossPp: 2,
  findingPrecisionMaxLossPp: 1,
  /** PRD §7.5: zero configured secret/PII leaks; zero cross-tenant resolution. */
  securityLeakMax: 0,
} as const;

// --- Evidence contract -------------------------------------------------------

export interface GroundingEvidence {
  /** Recall@1 of the UI Graph view representation, from Judgment Engine runs. */
  readonly viewRecallAt1: number;
  /** Recall@1 of the best competing baseline on the same paired items. */
  readonly bestBaselineRecallAt1: number;
  /** Optional paired discordant counts for an exact McNemar disclosure. */
  readonly pairedDiscordant?: { readonly viewOnly: number; readonly baselineOnly: number };
}

export interface FindingQualityEvidence {
  readonly recallLossPp: number;
  readonly precisionLossPp: number;
  readonly blockerRecallRegressed: boolean;
  readonly invalidRefIncrease: boolean;
}

export interface SecurityEvidence {
  readonly crossTenantResolutions: number;
  readonly redactionLeaks: number;
  /** ug-security fixtures: untrusted text always serialized as data. */
  readonly injectionSerializedAsData: boolean;
  /** TRD §15.2: a malformed/adversarial delta must never hash-validate. */
  readonly malformedDeltaAccepted: boolean;
}

export interface CohortEvidence {
  readonly cohort: EvalCohort;
  /** Positive = improvement. Any negative value is a cohort regression. */
  readonly textReduction?: number;
  readonly findingRecallLossPp?: number;
}

export interface PromotionEvidence {
  /** Offline representation benchmark (#20). */
  readonly benchmark?: RepresentationBenchmarkReport;
  /** Which benchmark candidate is the production representation under test. */
  readonly candidate?: BaselineId;
  readonly focusViewP95TextTokens?: number;
  readonly repeatedReviewCostReduction?: number;
  readonly validRefRate?: number;
  readonly grounding?: GroundingEvidence;
  readonly crossSnapshotMatchPrecision?: number;
  readonly coordTransformErrorCssPx?: number;
  readonly viewportShorterSideCssPx?: number;
  readonly deltaHashMatchRate?: number;
  readonly findingQuality?: FindingQualityEvidence;
  readonly security?: SecurityEvidence;
  /** Per-cohort results (TRD §15.3). Absence blocks promotion. */
  readonly perCohort?: readonly CohortEvidence[];
}

// --- Decision shapes -----------------------------------------------------------

export type GateStatus = "pass" | "fail" | "insufficient_evidence";

export interface GateResult {
  readonly gate: string;
  readonly prdRef: string;
  readonly status: GateStatus;
  readonly required: string;
  readonly observed?: string;
  readonly detail?: string;
}

export interface PromotionDecision {
  /** True only when EVERY gate passes. Insufficient evidence never promotes. */
  readonly promote: boolean;
  readonly results: readonly GateResult[];
  readonly summary: string;
  /** Optional McNemar disclosure for the grounding comparison, when supplied. */
  readonly groundingMcNemar?: McNemarResult;
}

// --- Evaluator -------------------------------------------------------------------

const fmtPct = (x: number): string => `${(x * 100).toFixed(2)}%`;

function findComparison(
  report: RepresentationBenchmarkReport,
  candidate: BaselineId,
): BaselineComparison | undefined {
  return report.comparisons.find((c) => c.candidate === candidate);
}

export function evaluatePromotion(evidence: PromotionEvidence): PromotionDecision {
  const results: GateResult[] = [];
  let groundingMcNemar: McNemarResult | undefined;

  // 7.1a — token reduction (CI lower bound; diagnostic rows inadmissible).
  {
    const gate = "token_reduction";
    const required = `95% CI lower bound ≥ ${fmtPct(PROMOTION_GATES.tokenReductionMin)} text-token reduction vs b0`;
    const candidate = evidence.candidate ?? "b5_focused_view";
    const comparison =
      evidence.benchmark !== undefined ? findComparison(evidence.benchmark, candidate) : undefined;
    if (comparison === undefined || !comparison.available || comparison.reductions === undefined) {
      results.push({
        gate,
        prdRef: "PRD §7.1",
        status: "insufficient_evidence",
        required,
        detail: `no available benchmark comparison for candidate ${candidate}`,
      });
    } else if (comparison.diagnosticOnly === true) {
      results.push({
        gate,
        prdRef: "PRD §7.1",
        status: "insufficient_evidence",
        required,
        detail: "comparison is diagnostic-only (pre-assembler composite); real serialized artifact required",
      });
    } else {
      const text = comparison.reductions.find((r) => r.metric === "text_tokens");
      if (text === undefined) {
        results.push({ gate, prdRef: "PRD §7.1", status: "insufficient_evidence", required });
      } else {
        const pass = text.reduction.lower >= PROMOTION_GATES.tokenReductionMin;
        results.push({
          gate,
          prdRef: "PRD §7.1",
          status: pass ? "pass" : "fail",
          required,
          observed: `point ${fmtPct(text.reduction.point)}, CI [${fmtPct(text.reduction.lower)}, ${fmtPct(text.reduction.upper)}] over ${text.reduction.pairs} paired fixtures`,
        });
      }
    }
  }

  // 7.1b — focus view p95 text tokens.
  pushThresholdGate(results, {
    gate: "focus_view_p95_text_tokens",
    prdRef: "PRD §7.1",
    observed: evidence.focusViewP95TextTokens,
    required: `p95 ≤ ${PROMOTION_GATES.focusViewP95TextTokensMax} text tokens`,
    pass: (v) => v <= PROMOTION_GATES.focusViewP95TextTokensMax,
    render: (v) => `${v} tokens`,
  });

  // 7.1c — repeated-review input cost reduction.
  pushThresholdGate(results, {
    gate: "repeated_review_cost_reduction",
    prdRef: "PRD §7.1",
    observed: evidence.repeatedReviewCostReduction,
    required: `≥ ${fmtPct(PROMOTION_GATES.repeatedReviewCostReductionMin)}`,
    pass: (v) => v >= PROMOTION_GATES.repeatedReviewCostReductionMin,
    render: fmtPct,
  });

  // 7.2a — valid-reference rate.
  pushThresholdGate(results, {
    gate: "valid_ref_rate",
    prdRef: "PRD §7.2",
    observed: evidence.validRefRate,
    required: `≥ ${fmtPct(PROMOTION_GATES.validRefRateMin)}`,
    pass: (v) => v >= PROMOTION_GATES.validRefRateMin,
    render: fmtPct,
  });

  // 7.2b — grounding Recall@1 within 1pp of best baseline.
  {
    const gate = "grounding_recall_at_1";
    const required = `view Recall@1 ≥ best baseline − ${PROMOTION_GATES.groundingRecallMaxLossPp}pp`;
    const g = evidence.grounding;
    if (g === undefined) {
      results.push({ gate, prdRef: "PRD §7.2", status: "insufficient_evidence", required });
    } else {
      const lossPp = (g.bestBaselineRecallAt1 - g.viewRecallAt1) * 100;
      if (g.pairedDiscordant !== undefined) {
        groundingMcNemar = mcnemarExact(g.pairedDiscordant.viewOnly, g.pairedDiscordant.baselineOnly);
      }
      results.push({
        gate,
        prdRef: "PRD §7.2",
        status: lossPp <= PROMOTION_GATES.groundingRecallMaxLossPp ? "pass" : "fail",
        required,
        observed:
          `view ${fmtPct(g.viewRecallAt1)}, best baseline ${fmtPct(g.bestBaselineRecallAt1)} (loss ${lossPp.toFixed(2)}pp)` +
          (groundingMcNemar !== undefined
            ? `; McNemar exact p=${groundingMcNemar.pValue.toFixed(4)} over ${groundingMcNemar.discordant} discordant pairs`
            : ""),
      });
    }
  }

  // 7.2c — cross-snapshot match precision.
  pushThresholdGate(results, {
    gate: "cross_snapshot_match_precision",
    prdRef: "PRD §7.2",
    observed: evidence.crossSnapshotMatchPrecision,
    required: `≥ ${fmtPct(PROMOTION_GATES.crossSnapshotMatchPrecisionMin)} (high-confidence matches; abstention allowed)`,
    pass: (v) => v >= PROMOTION_GATES.crossSnapshotMatchPrecisionMin,
    render: fmtPct,
  });

  // 7.2d — coordinate transform error.
  {
    const gate = "coord_transform_error";
    const err = evidence.coordTransformErrorCssPx;
    const side = evidence.viewportShorterSideCssPx;
    if (err === undefined || side === undefined) {
      results.push({
        gate,
        prdRef: "PRD §7.2",
        status: "insufficient_evidence",
        required: "≤ max(2 CSS px, 0.5% of shorter viewport side)",
      });
    } else {
      const budget = Math.max(
        PROMOTION_GATES.coordTransformErrorMaxCssPx,
        PROMOTION_GATES.coordTransformErrorMaxViewportFrac * side,
      );
      results.push({
        gate,
        prdRef: "PRD §7.2",
        status: err <= budget ? "pass" : "fail",
        required: `≤ ${budget.toFixed(2)} CSS px for a ${side}px shorter side`,
        observed: `${err.toFixed(2)} CSS px`,
      });
    }
  }

  // 7.2e — delta reconstruction.
  pushThresholdGate(results, {
    gate: "delta_hash_match_rate",
    prdRef: "PRD §7.2",
    observed: evidence.deltaHashMatchRate,
    required: "100% for valid deltas",
    pass: (v) => v >= PROMOTION_GATES.deltaHashMatchRateMin,
    render: fmtPct,
  });

  // 7.3 — judgment retention.
  {
    const gate = "finding_quality_retention";
    const required = `recall loss ≤ ${PROMOTION_GATES.findingRecallMaxLossPp}pp, precision loss ≤ ${PROMOTION_GATES.findingPrecisionMaxLossPp}pp, no blocker-recall regression, no invalid-ref increase`;
    const q = evidence.findingQuality;
    if (q === undefined) {
      results.push({ gate, prdRef: "PRD §7.3", status: "insufficient_evidence", required });
    } else {
      const pass =
        q.recallLossPp <= PROMOTION_GATES.findingRecallMaxLossPp &&
        q.precisionLossPp <= PROMOTION_GATES.findingPrecisionMaxLossPp &&
        !q.blockerRecallRegressed &&
        !q.invalidRefIncrease;
      results.push({
        gate,
        prdRef: "PRD §7.3",
        status: pass ? "pass" : "fail",
        required,
        observed: `recall −${q.recallLossPp.toFixed(2)}pp, precision −${q.precisionLossPp.toFixed(2)}pp, blockerRegressed=${String(q.blockerRecallRegressed)}, invalidRefIncrease=${String(q.invalidRefIncrease)}`,
      });
    }
  }

  // 7.5 — security.
  {
    const gate = "security";
    const required =
      "0 cross-tenant resolutions, 0 redaction leaks, injection serialized as data, malformed deltas rejected";
    const s = evidence.security;
    if (s === undefined) {
      results.push({ gate, prdRef: "PRD §7.5", status: "insufficient_evidence", required });
    } else {
      const pass =
        s.crossTenantResolutions <= PROMOTION_GATES.securityLeakMax &&
        s.redactionLeaks <= PROMOTION_GATES.securityLeakMax &&
        s.injectionSerializedAsData &&
        !s.malformedDeltaAccepted;
      results.push({
        gate,
        prdRef: "PRD §7.5",
        status: pass ? "pass" : "fail",
        required,
        observed: `crossTenant=${s.crossTenantResolutions}, redactionLeaks=${s.redactionLeaks}, injectionAsData=${String(s.injectionSerializedAsData)}, malformedDeltaAccepted=${String(s.malformedDeltaAccepted)}`,
      });
    }
  }

  // 15.3 — per-cohort disclosure with no hidden regression.
  {
    const gate = "per_cohort_no_hidden_regression";
    const required = "per-cohort results published; no cohort text-token or finding-recall regression";
    const cohorts = evidence.perCohort;
    if (cohorts === undefined || cohorts.length === 0) {
      results.push({ gate, prdRef: "TRD §15.3", status: "insufficient_evidence", required });
    } else {
      const regressions = cohorts.filter(
        (c) =>
          (c.textReduction !== undefined && c.textReduction < 0) ||
          (c.findingRecallLossPp !== undefined &&
            c.findingRecallLossPp > PROMOTION_GATES.findingRecallMaxLossPp),
      );
      results.push({
        gate,
        prdRef: "TRD §15.3",
        status: regressions.length === 0 ? "pass" : "fail",
        required,
        observed:
          regressions.length === 0
            ? `${cohorts.length} cohorts, none regressed`
            : `regressed cohorts: ${regressions.map((c) => c.cohort).join(", ")}`,
      });
    }
  }

  const promote = results.every((r) => r.status === "pass");
  const failing = results.filter((r) => r.status === "fail").length;
  const missing = results.filter((r) => r.status === "insufficient_evidence").length;
  const summary = promote
    ? `PROMOTE: all ${results.length} pre-registered gates pass (PRD §7; core #103 DECISION 4 satisfied)`
    : `DO NOT PROMOTE: ${failing} failing, ${missing} with insufficient evidence, of ${results.length} gates — UI Graph stays feature-flagged (core #103 DECISION 4)`;

  return groundingMcNemar !== undefined
    ? { promote, results, summary, groundingMcNemar }
    : { promote, results, summary };
}

function pushThresholdGate(
  results: GateResult[],
  spec: {
    gate: string;
    prdRef: string;
    observed: number | undefined;
    required: string;
    pass: (v: number) => boolean;
    render: (v: number) => string;
  },
): void {
  if (spec.observed === undefined) {
    results.push({
      gate: spec.gate,
      prdRef: spec.prdRef,
      status: "insufficient_evidence",
      required: spec.required,
    });
    return;
  }
  results.push({
    gate: spec.gate,
    prdRef: spec.prdRef,
    status: spec.pass(spec.observed) ? "pass" : "fail",
    required: spec.required,
    observed: spec.render(spec.observed),
  });
}
