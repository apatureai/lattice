/**
 * Public API surface for `@apature/ui-graph` (TRD §1).
 *
 * These are the four entry points Judgment Engine calls. In this scaffold slice
 * they validate their declared contracts and throw a typed `not_implemented`
 * error; later slices fill in the deterministic build/query/diff/delta logic.
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

// --- Cross-repo input read profiles (TRD §4) ----------------------------
//
// UI Graph does not redefine the producers' full schemas; it declares the
// minimum read profiles it consumes and records the source schema versions.
// These are deliberately structurally-minimal: later slices (#3) own the full
// `CaptureBundleReadProfile`/`UIDNAGraphProjectionReadProfile` and their golden
// fixtures. They are NOT fabricated upstream schemas — UI Graph mirrors only
// what it reads. See issue #3.

/** Opaque, structurally-minimal reference to a versioned capture bundle. */
export type CaptureBundleRef = {
  schemaVersion: string;
  captureId: string;
  captureVersion: string;
};

/** Opaque, structurally-minimal reference to a UI-DNA graph projection. */
export type UIDNAProjectionRef = {
  projectionSchemaVersion: string;
  dnaVersion: string;
  dnaContentDigest: string;
  state: "approved" | "draft" | "in_review" | "superseded" | "revoked";
};

// --- Build options (TRD §4.4) -------------------------------------------

export type UIGraphBuildOptions = {
  builderVersion: string;
  schemaVersion: string;
  relationPolicyVersion: string;
  dnaProjectionVersion: string;
  redactionPolicyVersion: string;
  /**
   * Build/use mode. Per core #103 DECISION 4, UI Graph is a feature-flagged
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
  capture: CaptureBundleRef;
  dna?: UIDNAProjectionRef;
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
  comparisonSnapshot?: UIGraphSnapshot;
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
  | "not_implemented"
  | "invalid_snapshot"
  | "invalid_view_spec"
  | "invalid_delta"
  | "stale_or_foreign_ref"
  | "delta_base_mismatch"
  | "non_approved_dna_in_production";

export class UIGraphError extends Error {
  readonly code: UIGraphErrorCode;
  constructor(code: UIGraphErrorCode, message: string) {
    super(message);
    this.name = "UIGraphError";
    this.code = code;
  }
}

const NOT_IMPLEMENTED = (entry: string): never => {
  throw new UIGraphError(
    "not_implemented",
    `${entry} is not implemented in this scaffold slice (issue #2).`,
  );
};

// --- API stubs (TRD §1) -------------------------------------------------

export async function buildUiGraph(
  _request: BuildUiGraphRequest,
): Promise<UIGraphBuildResult> {
  return NOT_IMPLEMENTED("buildUiGraph");
}

export function queryUiGraph(_request: QueryUiGraphRequest): UIGraphView {
  return NOT_IMPLEMENTED("queryUiGraph");
}

export function diffUiGraphs(
  _base: UIGraphSnapshot,
  _target: UIGraphSnapshot,
): UIGraphDiff {
  return NOT_IMPLEMENTED("diffUiGraphs");
}

export function applyUiGraphDelta(
  _base: UIGraphSnapshot,
  _delta: UIGraphDelta,
): UIGraphSnapshot {
  return NOT_IMPLEMENTED("applyUiGraphDelta");
}

export type { CoordinateSpace };
