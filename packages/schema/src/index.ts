/**
 * @apature/ui-graph: deterministic, UI-DNA-aware visual scene graph contract.
 *
 * UI Graph is a feature-flagged representation
 * EXPERIMENT until its precision/grounding/cost/latency eval proves value. This
 * package is the contract + deterministic representation library consumed by
 * Judgment Engine; it never calls a model, browser, sandbox, or network.
 */

export * from "./types.js";
export * from "./validate.js";
export * from "./api.js";
export { graphViewOf, viewSourceNodeOf } from "./query.js";
export * from "./canonical.js";
export * from "./readprofile.js";
export * from "./adapter.js";
export * from "./capability-descriptor.js";
export * from "./consumer-contract.js";
export * from "./pipeline/index.js";
export * from "./eval/index.js";
export { encodeUiGraphDelta, applyUiGraphDeltaStrict } from "./pipeline/delta.js";
export {
  UNTRUSTED_UI_CONTENT_OPEN,
  UNTRUSTED_UI_CONTENT_CLOSE,
  sanitizeUntrustedText,
  delimitUntrusted,
  assertNoSensitiveTextSurvives,
  sensitiveTextDigest,
} from "./pipeline/untrusted.js";
export { buildEvidenceRequests } from "./pipeline/evidence-request.js";
// `PlannedEvidenceRequest` is the planner's internal shape (candidate ids +
// multiple reasons). The schema-shaped `EvidenceRequest` a `UIGraphView` carries
// comes from `types.ts`; `queryUiGraph` converts between them.
export type {
  EvidenceRequest as PlannedEvidenceRequest,
  EvidenceRequestKind,
  EvidenceRequestReason,
  EvidenceRequestOptions,
  EvidenceRequestPlan,
  RejectedVisualTarget,
} from "./pipeline/evidence-request.js";
export {
  diffJsonSchema,
  checkVersionBump,
  readerSupportsMajor,
  migrateToCurrentMajor,
  CURRENT_SCHEMA_MAJOR,
} from "./schema-evolution.js";
export type { SchemaChange, SchemaChangeKind, VersionBumpVerdict, MigratedSnapshot } from "./schema-evolution.js";
