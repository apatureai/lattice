/**
 * Deterministic builder pipeline — stages 1 (validate) and 2 (normalize).
 *
 * `validateAndNormalize` runs the two together: it fails closed if validation
 * finds any structural error (no partial output), otherwise returns the
 * normalized facts that fusion (issue #6) consumes.
 */

import type { CaptureBundleReadProfile, AnyUIDNAReadProfile } from "../readprofile.js";
import { validateCapture, type ValidateResult } from "./validate.js";
import { normalizeCapture, type NormalizedCapture } from "./normalize.js";
import type { PipelineIssue } from "./errors.js";

export * from "./errors.js";
export * from "./geometry.js";
export * from "./color.js";
export * from "./css.js";
export * from "./text.js";
export { validateCapture, type ValidateResult } from "./validate.js";
export { normalizeCapture, type NormalizedCapture } from "./normalize.js";
export type { NormalizedNode, NormalizedGeometry, Visibility } from "./normalize.js";
export { fuseCapture } from "./fuse.js";
export type {
  FusionResult,
  FusedNode,
  FusedFact,
  FusedKind,
  FuseOptions,
} from "./fuse.js";
export { buildHierarchy } from "./hierarchy.js";
export type {
  HierarchyResult,
  NodeHierarchy,
  HierarchyTruncation,
  HierarchyOptions,
} from "./hierarchy.js";
export { heuristicSaliency, heuristicSaliencyProvider, rankBySaliency } from "./saliency.js";
export type { SaliencyScore, SaliencyProvider, SaliencyViewport } from "./saliency.js";
export { buildRelations } from "./relations.js";
export {
  renderFocusView,
  renderSummaryView,
  renderActionMapView,
  renderPatchContextView,
  VIEW_POLICY_VERSION,
} from "./views.js";
export type {
  GraphView,
  RenderedView,
  ViewMeta,
  ViewBudget,
  FocusOptions,
  SummaryOptions,
  ActionMapOptions,
  ActionMapEntry,
  PatchContextOptions,
  PatchContextSource,
  PatchContextEntry,
  PatchSelectorHint,
  ComponentFamilyCandidate,
} from "./views.js";
export type { RelationResult, RelationOptions } from "./relations.js";

export type ValidateAndNormalizeResult =
  | { ok: true; normalized: NormalizedCapture }
  | { ok: false; errors: PipelineIssue[] };

export function validateAndNormalize(
  capture: CaptureBundleReadProfile,
  dna?: AnyUIDNAReadProfile,
): ValidateAndNormalizeResult {
  const validated: ValidateResult = validateCapture(capture, dna);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  return { ok: true, normalized: normalizeCapture(validated.capture) };
}
