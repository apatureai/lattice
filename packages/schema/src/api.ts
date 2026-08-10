/**
 * Public API surface for `@apature/ui-graph` (TRD §1).
 *
 * These are the four entry points a consumer calls. `buildUiGraph` composes the
 * deterministic pipeline; query/diff/delta remain independently staged.
 *
 * "The consumer" throughout this package means whatever critique pipeline links
 * this library in and owns the parts it deliberately does not: capture,
 * inference, storage, delivery, and redaction. The reference consumer is the
 * sibling repo apatureai/judgment-engine
 * (https://github.com/apatureai/judgment-engine), a grounded vision-language
 * design reviewer. Nothing here depends on it, and any pipeline that supplies
 * the documented read profiles works the same way.
 *
 * The package is a deterministic library: no DB, model, browser, or network
 * capability crosses this boundary (TRD §2, §3.1).
 */

import type {
  UIGraphSnapshot,
  UIGraphView,
  UIGraphViewSpec,
  UIGraphDelta,
  UIGraphUseMode,
  CoordinateSpace,
} from "./types.js";
import type {
  AnyUIDNAReadProfile,
  CaptureBundleReadProfile,
} from "./readprofile.js";
import { BuildPipelineFailure, executeBuild } from "./builder.js";
import { executeQuery } from "./query.js";
import { applyUiGraphDeltaStrict } from "./pipeline/delta.js";
import { matchNodes } from "./pipeline/lineage.js";

// --- Cross-repo input read profiles (TRD §4) ----------------------------
//
// UI Graph has no resolver/storage authority. Callers supply the materialized
// producer read profiles owned by issue #3; the adapter validates exactly the
// fields this package consumes before any stage runs.

// --- Build options (TRD §4.4) -------------------------------------------

export type UIGraphBuildOptions = {
  builderVersion: string;
  schemaVersion: string;
  relationPolicyVersion: string;
  dnaProjectionVersion: string;
  redactionPolicyVersion: string;
  /**
   * Build/use mode. Per PRD §9, UI Graph is a feature-flagged
   * representation experiment: production builds reject non-approved DNA and may
   * emit authoritative matches; `shadow`/`offline_eval` builds force every DNA
   * match non-authoritative (TRD §4.3, §8.7, §16). The mode participates in the
   * deterministic input hash and cache key (TRD §13) so shadow and production
   * artifacts never collide (issue #23).
   */
  useMode: UIGraphUseMode;
  maxNodes: number;
  maxPersistedEdgesPerNode: number;
  repeatedRegionThreshold: number;
  textPolicy: "full" | "truncate" | "hash_sensitive";
  includeHiddenExplanatoryNodes: boolean;
};

export type BuildUiGraphRequest = {
  capture: CaptureBundleReadProfile;
  dna?: AnyUIDNAReadProfile;
  options: UIGraphBuildOptions;
};

export type UIGraphBuildResult = {
  snapshot: UIGraphSnapshot;
  diagnostics: {
    builtAt: string;
    timingMs: {
      validate: number;
      normalize: number;
      fuse: number;
      relations: number;
      dnaProjection: number;
      serialize: number;
      total: number;
    };
    peakMemoryBytes?: number;
    canonicalJsonBytes: number;
    compressedBytes?: number;
    counters: Record<string, number>;
  };
};

export type QueryUiGraphRequest = {
  snapshot: UIGraphSnapshot;
  spec: UIGraphViewSpec;
  /** Required for `kind: "diff"`; its identity must equal the spec's comparison tuple. */
  comparisonSnapshot?: UIGraphSnapshot;
  /**
   * Logical artifact ref of the capture's screenshot (`artifact://…`). A sealed
   * snapshot carries no screenshot pointer (pixels never enter this package),
   * so evidence requests are planned only when the caller supplies one.
   */
  screenshotArtifactRef?: string;
};

export type UIGraphNodeMatch = {
  baseNodeId: string;
  targetNodeId?: string;
  status: "matched" | "removed" | "ambiguous" | "abstained";
  score: number;
  features: Array<{ name: string; score: number }>;
};

export type UIGraphDiff = {
  baseSnapshotId: string;
  targetSnapshotId: string;
  matches: UIGraphNodeMatch[];
};

// --- Typed errors (TRD §16) ---------------------------------------------

export type UIGraphErrorCode =
  | "invalid_build_options"
  | "invalid_capture"
  | "invalid_dna"
  | "invalid_snapshot"
  | "invalid_view_spec"
  | "invalid_delta"
  | "stale_or_foreign_ref"
  | "delta_base_mismatch"
  | "non_approved_dna_in_production";

export class UIGraphError extends Error {
  readonly code: UIGraphErrorCode;
  readonly issues: ReadonlyArray<{ code: string; message: string }>;
  constructor(
    code: UIGraphErrorCode,
    message: string,
    issues: ReadonlyArray<{ code: string; message: string }> = [],
  ) {
    super(message);
    this.name = "UIGraphError";
    this.code = code;
    this.issues = issues;
  }
}

// --- Public entry points (TRD §1) ---------------------------------------

export async function buildUiGraph(
  request: BuildUiGraphRequest,
): Promise<UIGraphBuildResult> {
  try {
    return await executeBuild(request);
  } catch (error) {
    if (error instanceof BuildPipelineFailure) {
      throw new UIGraphError(error.code, error.message, error.issues);
    }
    throw error;
  }
}

/**
 * Answer one bounded question about a sealed snapshot (TRD §10; PRD §6.4).
 *
 * Verifies snapshot identity and every supplied ref, validates the spec,
 * dispatches to the renderer for `spec.kind`, enforces the node/edge/text-token
 * budgets by truncating (never by erroring), and returns the schema-shaped
 * `UIGraphView` envelope. Pure and deterministic: the same (snapshot, spec)
 * always yields a byte-identical view. See `src/query.ts`.
 */
export function queryUiGraph(request: QueryUiGraphRequest): UIGraphView {
  return executeQuery(request);
}

/** Cross-snapshot node lineage (#13): deterministic matches with abstention. */
export function diffUiGraphs(
  base: UIGraphSnapshot,
  target: UIGraphSnapshot,
): UIGraphDiff {
  return {
    baseSnapshotId: base.snapshotId,
    targetSnapshotId: target.snapshotId,
    matches: matchNodes(base.nodes, target.nodes),
  };
}

/**
 * Hash-verified delta application (#14; TRD §12): verified base binding,
 * ordered ID-keyed ops, explicit incident-edge removal, re-sealed target that
 * must equal the delta's declared identity, or a typed error and NO partial
 * result. Deltas are transport artifacts; full snapshots remain canonical.
 */
export function applyUiGraphDelta(
  base: UIGraphSnapshot,
  delta: UIGraphDelta,
): UIGraphSnapshot {
  return applyUiGraphDeltaStrict(base, delta);
}

export type { CoordinateSpace };
