/**
 * Pipeline stage 5: bounded relation builder (TRD §5.5, §8.6; ADR-004).
 *
 * Builds the deterministic typed edge set over the fused nodes (#6) + hierarchy
 * (#7). Persisted edges stay bounded O(n): candidate generation for the
 * geometry relations uses a spatial grid rather than an unconditional O(n²)
 * scan, and a per-node cap drops the lowest-value NON-structural edges while
 * `contains` (the required hierarchy) is never dropped. Dense similarity
 * (component-family / token / embedding neighbors) is deferred to query time.
 *
 * Edge kinds here: `contains` (hierarchy, directed, protected), `reading_next`
 * (source order corrected by geometry within a region, directed), `overlaps`
 * (IoU threshold, symmetric), `aligned_start/center/end` (tolerance + same
 * region, symmetric), `near` (k-nearest, symmetric). Symmetric edges use a
 * canonical (min,max) node ordering. Deterministic.
 */

import { createHash } from "node:crypto";
import type { Rect, UIGraphEdge } from "../types.js";
import type { FusedNode } from "./fuse.js";
import { compareCodeUnits } from "../canonical.js";
import type { NodeHierarchy } from "./hierarchy.js";

export interface RelationOptions {
  maxPersistedEdgesPerNode?: number;
  iouThreshold?: number;
  alignmentTolerancePx?: number;
  nearK?: number;
}

export interface RelationResult {
  edges: UIGraphEdge[];
  metrics: { edges: number; maxDegree: number };
}

const WEIGHT = { contains: 1, reading_next: 0.7, overlaps: 0.6, aligned: 0.5, near: 0.3 } as const;

function edgeId(kind: string, a: string, b: string): string {
  return `e_${createHash("sha256").update(`${kind}:${a}:${b}`, "utf8").digest("hex").slice(0, 16)}`;
}

function centroid(r: Rect): [number, number] {
  return [r.x + r.width / 2, r.y + r.height / 2];
}

function iou(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

/** A coarse grid so overlap/near candidate generation stays sub-quadratic. */
class SpatialGrid {
  private readonly cell: number;
  private readonly buckets = new Map<string, string[]>();
  constructor(cell: number) {
    this.cell = Math.max(1, cell);
  }
  private keys(r: Rect): string[] {
    const out: string[] = [];
    for (let cx = Math.floor(r.x / this.cell); cx <= Math.floor((r.x + r.width) / this.cell); cx++) {
      for (let cy = Math.floor(r.y / this.cell); cy <= Math.floor((r.y + r.height) / this.cell); cy++) out.push(`${cx},${cy}`);
    }
    return out;
  }
  insert(id: string, r: Rect): void {
    // Push into the existing bucket array rather than spread-copying it: the old
    // `set(k, [...(get(k) ?? []), id])` reallocated the whole bucket per insert,
    // making a run of inserts into one cell O(n²). Append order is unchanged.
    for (const k of this.keys(r)) {
      let bucket = this.buckets.get(k);
      if (bucket === undefined) {
        bucket = [];
        this.buckets.set(k, bucket);
      }
      bucket.push(id);
    }
  }
  candidates(id: string, r: Rect): string[] {
    const found = new Set<string>();
    for (const k of this.keys(r)) for (const other of this.buckets.get(k) ?? []) if (other !== id) found.add(other);
    return [...found];
  }
}

function symmetric(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function mkEdge(kind: UIGraphEdge["kind"], from: string, to: string, directed: boolean, weight: number, attributes: UIGraphEdge["attributes"], evidence: UIGraphEdge["evidence"]): UIGraphEdge {
  return { edgeId: edgeId(kind, from, to), fromNodeId: from, toNodeId: to, kind, directed, weight, attributes, evidence };
}

export function buildRelations(nodes: readonly FusedNode[], hierarchy: readonly NodeHierarchy[], options: RelationOptions = {}): RelationResult {
  const iouThreshold = options.iouThreshold ?? 0.1;
  const tol = options.alignmentTolerancePx ?? 4;
  const nearK = options.nearK ?? 4;
  const maxDegree = options.maxPersistedEdgesPerNode ?? 32;

  const byId = new Map(nodes.map((n) => [n.candidateId, n]));
  const hierById = new Map(hierarchy.map((h) => [h.candidateId, h]));
  const withGeom = [...nodes].filter((n) => n.geometry !== undefined).sort((a, b) => compareCodeUnits(a.candidateId, b.candidateId));

  const edges = new Map<string, UIGraphEdge>();
  const add = (e: UIGraphEdge): void => {
    if (!edges.has(e.edgeId)) edges.set(e.edgeId, e);
  };

  // contains (from hierarchy): protected structural edges.
  for (const h of hierarchy) {
    if (h.parentNodeId !== undefined) add(mkEdge("contains", h.parentNodeId, h.candidateId, true, WEIGHT.contains, {}, []));
  }

  // reading_next: siblings under a parent, source order corrected by geometry.
  const byParent = new Map<string, FusedNode[]>();
  for (const n of withGeom) {
    const p = hierById.get(n.candidateId)?.parentNodeId ?? "__root__";
    // Append into the existing sibling array (same reason as SpatialGrid.insert):
    // the prior spread-copy was O(siblings²) when many nodes share one parent.
    // `withGeom` is already sorted, so append order (and thus every downstream
    // sort/edge) is byte-identical to before.
    let siblings = byParent.get(p);
    if (siblings === undefined) {
      siblings = [];
      byParent.set(p, siblings);
    }
    siblings.push(n);
  }
  for (const siblings of byParent.values()) {
    const ordered = [...siblings].sort((a, b) => {
      const ga = a.geometry!.viewportRect;
      const gb = b.geometry!.viewportRect;
      return ga.y - gb.y || ga.x - gb.x || compareCodeUnits(a.candidateId, b.candidateId);
    });
    for (let i = 0; i + 1 < ordered.length; i++) add(mkEdge("reading_next", ordered[i]!.candidateId, ordered[i + 1]!.candidateId, true, WEIGHT.reading_next, {}, []));
  }

  // Spatial grid for overlaps + near candidate generation (sub-quadratic).
  let span = 100;
  for (const n of withGeom) span = Math.max(span, n.geometry!.viewportRect.x + n.geometry!.viewportRect.width, n.geometry!.viewportRect.y + n.geometry!.viewportRect.height);
  const grid = new SpatialGrid(Math.max(50, span / 20));
  for (const n of withGeom) grid.insert(n.candidateId, n.geometry!.viewportRect);

  const shareRegion = (a: string, b: string): boolean => {
    const ra = new Set(hierById.get(a)?.regionIds ?? []);
    return (hierById.get(b)?.regionIds ?? []).some((r) => ra.has(r));
  };

  for (const n of withGeom) {
    const g = n.geometry!.viewportRect;
    const cands = grid.candidates(n.candidateId, g).map((id) => byId.get(id)!).filter((c) => c.geometry !== undefined);

    // overlaps (symmetric, IoU-weighted).
    for (const c of cands) {
      const score = iou(g, c.geometry!.viewportRect);
      if (score >= iouThreshold) {
        const [lo, hi] = symmetric(n.candidateId, c.candidateId);
        add(mkEdge("overlaps", lo, hi, false, score, { iou: Number(score.toFixed(3)) }, []));
      }
    }

    // alignment (same region, within tolerance, symmetric).
    for (const c of cands) {
      if (!shareRegion(n.candidateId, c.candidateId)) continue;
      const cg = c.geometry!.viewportRect;
      const [lo, hi] = symmetric(n.candidateId, c.candidateId);
      if (Math.abs(g.x - cg.x) <= tol) add(mkEdge("aligned_start", lo, hi, false, WEIGHT.aligned, {}, []));
      if (Math.abs(g.x + g.width / 2 - (cg.x + cg.width / 2)) <= tol) add(mkEdge("aligned_center", lo, hi, false, WEIGHT.aligned, {}, []));
      if (Math.abs(g.x + g.width - (cg.x + cg.width)) <= tol) add(mkEdge("aligned_end", lo, hi, false, WEIGHT.aligned, {}, []));
    }

    // near: k nearest by centroid among spatial candidates.
    const [nx, ny] = centroid(g);
    const nearest = cands
      .map((c) => {
        const [cx, cy] = centroid(c.geometry!.viewportRect);
        return { id: c.candidateId, d: Math.hypot(cx - nx, cy - ny) };
      })
      .sort((a, b) => a.d - b.d || compareCodeUnits(a.id, b.id))
      .slice(0, nearK);
    for (const near of nearest) {
      const [lo, hi] = symmetric(n.candidateId, near.id);
      add(mkEdge("near", lo, hi, false, WEIGHT.near, {}, []));
    }
  }

  const capped = enforceCap([...edges.values()], maxDegree);
  const degree = new Map<string, number>();
  for (const e of capped) {
    degree.set(e.fromNodeId, (degree.get(e.fromNodeId) ?? 0) + 1);
    degree.set(e.toNodeId, (degree.get(e.toNodeId) ?? 0) + 1);
  }
  const observedMax = degree.size === 0 ? 0 : Math.max(...degree.values());

  return {
    edges: capped.sort((a, b) => compareCodeUnits(a.edgeId, b.edgeId)),
    metrics: { edges: capped.length, maxDegree: observedMax },
  };
}

/** Drop the lowest-weight NON-structural edges from any over-degree node; keep `contains`. */
function enforceCap(all: UIGraphEdge[], maxDegree: number): UIGraphEdge[] {
  const degree = new Map<string, number>();
  const bump = (e: UIGraphEdge, d: number): void => {
    degree.set(e.fromNodeId, (degree.get(e.fromNodeId) ?? 0) + d);
    degree.set(e.toNodeId, (degree.get(e.toNodeId) ?? 0) + d);
  };
  for (const e of all) bump(e, 1);

  // Consider droppable edges lowest-weight first (deterministic tiebreak by id).
  const droppable = all
    .filter((e) => e.kind !== "contains")
    .sort((a, b) => a.weight - b.weight || compareCodeUnits(a.edgeId, b.edgeId));
  const dropped = new Set<string>();
  for (const e of droppable) {
    if ((degree.get(e.fromNodeId) ?? 0) > maxDegree || (degree.get(e.toNodeId) ?? 0) > maxDegree) {
      dropped.add(e.edgeId);
      bump(e, -1);
    }
  }
  return all.filter((e) => !dropped.has(e.edgeId));
}
