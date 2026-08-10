/**
 * The R1-exit decision report (#24; PRD §9 R2→R3,
 * ARCHITECTURE §15 promotion diamond).
 *
 * `evaluatePromotion` (gates.ts) computes per-gate pass/fail/insufficient;
 * this module turns that into THE artifact a feature-flag flip (or rejection)
 * cites: a content-addressed report with an explicit three-way verdict and
 * every version stamp needed to reproduce it.
 *
 * Verdict semantics (fail-closed, PRD §7):
 *  - `gate_met`:      every gate passed; the documented precondition for
 *                       leaving shadow is satisfied.
 *  - `gate_rejected`: at least one gate FAILED on sufficient evidence; the
 *                       experiment does not promote in this form.
 *  - `inconclusive`:  no gate failed but at least one had insufficient
 *                       evidence; never treated as met (missing data is not
 *                       a pass), never mislabeled as a rejection.
 *
 * The report is deterministic for the same inputs and content-addressed over
 * its canonical body, so citing its hash pins exactly which fixtures, builder,
 * and tokenizer/model profiles produced the decision.
 */

import { createHash } from "node:crypto";
import { canonicalize } from "../canonical.js";
import { SCHEMA_VERSION } from "../types.js";
import type { RepresentationBenchmarkReport } from "./benchmark.js";
import type { PromotionDecision } from "./gates.js";

export type PromotionVerdict = "gate_met" | "gate_rejected" | "inconclusive";

export interface RepresentationDecisionReport {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly verdict: PromotionVerdict;
  readonly decision: PromotionDecision;
  /** Everything needed to reproduce the run this decision was made on. */
  readonly provenance: {
    readonly manifestContentHash: string;
    readonly benchmarkContentHash: string;
    readonly builderSchemaVersion: typeof SCHEMA_VERSION;
    readonly tokenAccountingProfiles: RepresentationBenchmarkReport["profiles"];
    readonly benchmarkOptions: RepresentationBenchmarkReport["options"];
  };
  /** Content-addressed over the canonical report body (excluding itself). */
  readonly reportContentHash: string;
}

/** Derive the explicit three-way verdict from the per-gate results. */
export function promotionVerdict(decision: PromotionDecision): PromotionVerdict {
  const statuses = decision.results.map((r) => r.status);
  if (statuses.some((s) => s === "fail")) return "gate_rejected";
  if (statuses.some((s) => s === "insufficient_evidence")) return "inconclusive";
  return "gate_met";
}

/** Build the frozen, citable decision artifact for an evaluated benchmark run. */
export function buildDecisionReport(
  benchmark: RepresentationBenchmarkReport,
  decision: PromotionDecision,
): RepresentationDecisionReport {
  const verdict = promotionVerdict(decision);
  if (verdict === "gate_met" && !decision.promote) {
    // Defensive consistency: gates.ts promote=true iff every gate passed.
    throw new Error("decision report: verdict gate_met but decision.promote is false");
  }
  const body = {
    schemaVersion: SCHEMA_VERSION,
    verdict,
    decision,
    provenance: {
      manifestContentHash: benchmark.manifestContentHash,
      benchmarkContentHash: benchmark.contentHash,
      builderSchemaVersion: SCHEMA_VERSION,
      tokenAccountingProfiles: benchmark.profiles,
      benchmarkOptions: benchmark.options,
    },
  };
  const reportContentHash = `sha256:${createHash("sha256").update(canonicalize(body), "utf8").digest("hex")}`;
  return { ...body, reportContentHash };
}
