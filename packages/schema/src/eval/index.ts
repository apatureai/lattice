/**
 * Representation evaluation surface (PRD §8, TRD §15).
 *
 * UI Graph owns the frozen fixture manifests + labels; Judgment Engine runs the
 * eval. This barrel exposes the manifest format (issue #19), the frozen
 * manifest data, the offline benchmark runner (#20) with its deterministic
 * statistics, and the pre-registered promotion-gate evaluator (#24).
 */

export * from "./manifest.js";
export { REPRESENTATION_MANIFEST } from "./fixtures.js";
export { syntheticCapture, syntheticDna, SYNTHETIC_SCREENSHOT_ARTIFACT_REF } from "./synthetic-page.js";
export type { SyntheticPageOptions } from "./synthetic-page.js";
export * from "./stats.js";
export * from "./benchmark.js";
export * from "./gates.js";
export { applyDeltaMutation, deltaChainHashes } from "./delta-mutations.js";
export type { DeltaMutationKind } from "./delta-mutations.js";
export { buildDecisionReport, promotionVerdict } from "./decision-report.js";
export type { PromotionVerdict, RepresentationDecisionReport } from "./decision-report.js";
