/**
 * The node/edge/hierarchy shapes the view + evidence-request layer reads.
 *
 * These are deliberately STRUCTURAL SUBSETS, not new data. An in-flight
 * `FusedNode` satisfies `ViewSourceNode` as-is, and `queryUiGraph` projects a
 * sealed `UIGraphNode` onto the same shape keyed by `elementRef`. That is what
 * lets one set of renderers serve both the pipeline path (`fuse → hierarchy →
 * relations → render`) and the snapshot path (`sealed snapshot → render`)
 * instead of two divergent seams.
 *
 * Nothing here is serialized directly; `views.ts` projects further down to the
 * prompt shapes before any text is produced.
 */

import type { EvidenceClaim, Rect, SensitivityLabel } from "../types.js";

/** A fact resolved from competing source claims (mirrors `FusedFact`). */
export interface ViewSourceFact<T> {
  readonly value: T;
  readonly confidence: number;
  readonly conflict: boolean;
}

export interface ViewSourceGeometry {
  readonly viewportRect: Rect;
  /**
   * Absent when the element is outside the viewport: there is no honest [0,1]
   * position for it, and a clamped one would be a lie (TRD §7).
   */
  readonly normalizedViewportRect?: Rect;
  readonly visibility: string;
  readonly clipped: boolean;
}

export interface ViewSourceNode {
  /** Snapshot-local ref: `FusedNode.candidateId` in flight, `elementRef` once sealed. */
  readonly candidateId: string;
  readonly kind: string;
  readonly frameId: string;
  readonly geometry?: ViewSourceGeometry;
  readonly role?: ViewSourceFact<string>;
  readonly name?: ViewSourceFact<string>;
  readonly text?: ViewSourceFact<string>;
  readonly flags: readonly string[];
  readonly confidence: number;
  /** Provenance. Read for evidence-request reasons; never serialized into a view. */
  readonly evidence?: readonly EvidenceClaim[];
  readonly sensitivity?: readonly SensitivityLabel[];
}

/** A structural subset of `UIGraphEdge`. */
export interface ViewSourceEdge {
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: string;
}

/** A structural subset of `NodeHierarchy`. */
export interface ViewSourceHierarchy {
  readonly candidateId: string;
  readonly parentNodeId?: string;
  readonly regionIds: readonly string[];
  readonly depth: number;
}
