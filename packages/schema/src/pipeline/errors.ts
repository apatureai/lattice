/**
 * Structured pipeline diagnostics (TRD §16, §17.2).
 *
 * The validate + normalize stages are fail-closed: on any `error`-severity issue
 * the stage returns no partial output. `warning`/`info` issues are non-fatal and
 * accompany a successful result. Every issue carries a stable `code` so callers
 * branch on the failure class rather than parsing prose.
 */

export type PipelineErrorCode =
  | "unsupported_capture_major"
  | "unsupported_dna_major"
  | "invalid_viewport"
  | "duplicate_source_id"
  | "missing_parent"
  | "parent_cycle"
  | "non_finite_geometry"
  | "geometry_overflow"
  | "invalid_transform"
  | "invalid_redaction_metadata"
  | "invalid_artifact_ref"
  | "derived_missing_provenance"
  | "unresolved_coordinate_space"
  | "transform_tolerance_exceeded"
  | "unparseable_color"
  | "unparseable_length";

export type PipelineSeverity = "error" | "warning" | "info";

export interface PipelineIssue {
  readonly code: PipelineErrorCode;
  readonly severity: PipelineSeverity;
  readonly message: string;
  readonly sourceId?: string;
  readonly frameId?: string;
}

export function err(
  code: PipelineErrorCode,
  message: string,
  ctx?: { sourceId?: string; frameId?: string },
): PipelineIssue {
  return { code, severity: "error", message, ...ctx };
}

export function warn(
  code: PipelineErrorCode,
  message: string,
  ctx?: { sourceId?: string; frameId?: string },
): PipelineIssue {
  return { code, severity: "warning", message, ...ctx };
}
