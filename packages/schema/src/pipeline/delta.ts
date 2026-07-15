/**
 * Typed ID-keyed delta transport (#14; TRD §12, ADR-008, ARCHITECTURE §10;
 * PRD §18.29). A delta is ONLY a hash-validated transport from one full
 * snapshot to another — never an event store, never memory, never canonical.
 * Full snapshots remain the canonical artifacts; deltas are not chained
 * indefinitely (each binds exactly one verified base to one verified target).
 *
 * Encode: `encodeUiGraphDelta(base, target)` emits ordered operations keyed by
 * stable IDs, with the full base/target `(snapshotId, contentHash)` tuples.
 * Node removals carry EXPLICIT incident-edge removals — an applier never
 * cascades implicitly.
 *
 * Apply: `applyUiGraphDelta(base, delta)` fails closed at every step — base
 * identity recomputed (never trusted), schema majors checked, ops applied in
 * order over ID-keyed maps, dangling references rejected, and the
 * reconstructed target re-sealed and verified equal to the delta's declared
 * `(targetSnapshotId, targetContentHash)`. Any failure returns NO partial
 * target: a delta that cannot reproduce a hash-valid snapshot is worthless by
 * design (PRD §7.5).
 */

import { createHash } from "node:crypto";
import { UIGraphError } from "../api.js";
import { canonicalize, computeContentHash, deriveSnapshotId, sealSnapshot } from "../canonical.js";
import { SCHEMA_VERSION } from "../types.js";
import type {
  UIGraphDelta,
  UIGraphDeltaOperation,
  UIGraphEdge,
  UIGraphNode,
  UIGraphSnapshot,
  UIRegion,
} from "../types.js";

const sameJson = (a: unknown, b: unknown): boolean =>
  a === undefined || b === undefined ? a === b : canonicalize(a) === canonicalize(b);

function byId<T>(items: readonly T[], id: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(id(item), item);
  return map;
}

/** Verify a snapshot's identity from its content — supplied fields are never trusted. */
function assertVerifiedIdentity(snapshot: UIGraphSnapshot, role: "base" | "target"): void {
  const contentHash = computeContentHash(snapshot);
  if (snapshot.contentHash !== contentHash || snapshot.snapshotId !== deriveSnapshotId(snapshot, contentHash)) {
    throw new UIGraphError("invalid_snapshot", `${role} snapshot identity does not match its content`);
  }
}

/**
 * Encode the ordered operation list that rewrites `base` into `target`.
 * Deterministic: operations are emitted in canonical ID order per collection.
 */
export function encodeUiGraphDelta(base: UIGraphSnapshot, target: UIGraphSnapshot): UIGraphDelta {
  assertVerifiedIdentity(base, "base");
  assertVerifiedIdentity(target, "target");

  const operations: UIGraphDeltaOperation[] = [];

  if (
    !sameJson(base.build, target.build) ||
    !sameJson(base.source, target.source) ||
    !sameJson(base.coordinateSpaces, target.coordinateSpaces)
  ) {
    operations.push({
      op: "replace_header",
      build: target.build,
      source: target.source,
      coordinateSpaces: target.coordinateSpaces,
    });
  }

  const baseNodes = byId(base.nodes, (n) => n.nodeId);
  const targetNodes = byId(target.nodes, (n) => n.nodeId);
  const baseEdges = byId(base.edges, (e) => e.edgeId);
  const targetEdges = byId(target.edges, (e) => e.edgeId);
  const baseRegions = byId(base.regions, (r) => r.regionId);
  const targetRegions = byId(target.regions, (r) => r.regionId);

  // Removals first (nodes carry their incident-edge removals explicitly).
  for (const [edgeId] of [...baseEdges].sort(([a], [b]) => a.localeCompare(b))) {
    if (!targetEdges.has(edgeId)) operations.push({ op: "remove_edge", edgeId });
  }
  for (const [nodeId] of [...baseNodes].sort(([a], [b]) => a.localeCompare(b))) {
    if (!targetNodes.has(nodeId)) operations.push({ op: "remove_node", nodeId });
  }
  for (const [regionId] of [...baseRegions].sort(([a], [b]) => a.localeCompare(b))) {
    if (!targetRegions.has(regionId)) operations.push({ op: "remove_region", regionId });
  }

  // Upserts in canonical ID order. Element refs are seal-owned, so node
  // equality is compared WITHOUT elementRef (the applier re-seals).
  const nodeBody = ({ elementRef: _r, ...rest }: UIGraphNode): unknown => rest;
  for (const [nodeId, node] of [...targetNodes].sort(([a], [b]) => a.localeCompare(b))) {
    const before = baseNodes.get(nodeId);
    if (before === undefined || !sameJson(nodeBody(before), nodeBody(node))) {
      operations.push({ op: "upsert_node", node });
    }
  }
  for (const [edgeId, edge] of [...targetEdges].sort(([a], [b]) => a.localeCompare(b))) {
    const before = baseEdges.get(edgeId);
    if (before === undefined || !sameJson(before, edge)) operations.push({ op: "upsert_edge", edge });
  }
  for (const [regionId, region] of [...targetRegions].sort(([a], [b]) => a.localeCompare(b))) {
    const before = baseRegions.get(regionId);
    if (before === undefined || !sameJson(before, region)) operations.push({ op: "upsert_region", region });
  }

  if (!sameJson(base.dnaProjection, target.dnaProjection)) {
    operations.push({
      op: "replace_dna_projection",
      ...(target.dnaProjection !== undefined ? { dnaProjection: target.dnaProjection } : {}),
    });
  }
  if (!sameJson(base.metrics, target.metrics)) operations.push({ op: "replace_metrics", metrics: target.metrics });
  if (!sameJson(base.warnings, target.warnings)) operations.push({ op: "replace_warnings", warnings: target.warnings });

  const body = {
    schemaVersion: SCHEMA_VERSION,
    baseSnapshotSchemaVersion: base.schemaVersion,
    baseSnapshotId: base.snapshotId,
    baseContentHash: base.contentHash,
    targetSnapshotSchemaVersion: target.schemaVersion,
    targetSnapshotId: target.snapshotId,
    targetContentHash: target.contentHash,
    sequence: 1,
    operations,
    createdAt: new Date(0).toISOString(), // deterministic: deltas are content-addressed transport, not events
  };
  // Content-addressed delta id over the canonical body (deterministic).
  const deltaId = `ugd_${createHash("sha256").update(canonicalize(body), "utf8").digest("hex").slice(0, 16)}`;
  return { ...body, deltaId } as UIGraphDelta;
}

/**
 * Apply a delta to a verified base and return the reconstructed, re-sealed
 * target — or throw a typed error with NO partial result (TRD §12 rules).
 */
export function applyUiGraphDeltaStrict(base: UIGraphSnapshot, delta: UIGraphDelta): UIGraphSnapshot {
  if (delta.schemaVersion !== SCHEMA_VERSION || delta.baseSnapshotSchemaVersion !== SCHEMA_VERSION || delta.targetSnapshotSchemaVersion !== SCHEMA_VERSION) {
    throw new UIGraphError("invalid_delta", "unsupported delta or snapshot schema version");
  }
  if (!Array.isArray(delta.operations)) throw new UIGraphError("invalid_delta", "delta operations must be an array");

  // Base binding: recompute identity from content, then require exact tuple match.
  assertVerifiedIdentity(base, "base");
  if (delta.baseSnapshotId !== base.snapshotId || delta.baseContentHash !== base.contentHash) {
    throw new UIGraphError("delta_base_mismatch", "delta does not bind to this base snapshot");
  }

  let build = base.build;
  let source = base.source;
  let coordinateSpaces = base.coordinateSpaces;
  const nodes = byId(structuredClone(base.nodes) as UIGraphNode[], (n) => n.nodeId);
  const edges = byId(structuredClone(base.edges) as UIGraphEdge[], (e) => e.edgeId);
  const regions = byId(structuredClone(base.regions) as UIRegion[], (r) => r.regionId);
  let dnaProjection = structuredClone(base.dnaProjection);
  let metrics = base.metrics;
  let warnings = base.warnings;

  for (const operation of delta.operations) {
    switch (operation.op) {
      case "replace_header":
        build = operation.build;
        source = operation.source;
        coordinateSpaces = operation.coordinateSpaces;
        break;
      case "upsert_node":
        nodes.set(operation.node.nodeId, operation.node);
        break;
      case "remove_node": {
        if (!nodes.delete(operation.nodeId)) {
          throw new UIGraphError("invalid_delta", `remove_node ${operation.nodeId}: no such node`);
        }
        // NO implicit cascade: incident edges must have been removed explicitly.
        for (const edge of edges.values()) {
          if (edge.fromNodeId === operation.nodeId || edge.toNodeId === operation.nodeId) {
            throw new UIGraphError(
              "invalid_delta",
              `remove_node ${operation.nodeId} leaves incident edge ${edge.edgeId}; deltas must remove edges explicitly`,
            );
          }
        }
        break;
      }
      case "upsert_edge":
        edges.set(operation.edge.edgeId, operation.edge);
        break;
      case "remove_edge":
        if (!edges.delete(operation.edgeId)) {
          throw new UIGraphError("invalid_delta", `remove_edge ${operation.edgeId}: no such edge`);
        }
        break;
      case "upsert_region":
        regions.set(operation.region.regionId, operation.region);
        break;
      case "remove_region":
        if (!regions.delete(operation.regionId)) {
          throw new UIGraphError("invalid_delta", `remove_region ${operation.regionId}: no such region`);
        }
        break;
      case "replace_dna_projection":
        dnaProjection = operation.dnaProjection;
        break;
      case "replace_metrics":
        metrics = operation.metrics;
        break;
      case "replace_warnings":
        warnings = operation.warnings;
        break;
      default: {
        const never: never = operation;
        throw new UIGraphError("invalid_delta", `unknown delta operation ${JSON.stringify(never)}`);
      }
    }
  }

  // Reconstruct: strip seal-owned refs, re-seal, then verify the declared target
  // tuple. A mismatch yields NO partial target — the delta is rejected whole.
  let sealed: UIGraphSnapshot;
  try {
    sealed = sealSnapshot({
      schemaVersion: SCHEMA_VERSION,
      build,
      source,
      coordinateSpaces,
      nodes: [...nodes.values()].map(({ elementRef: _r, ...node }) => node),
      edges: [...edges.values()],
      regions: [...regions.values()],
      ...(dnaProjection !== undefined ? { dnaProjection } : {}),
      metrics,
      warnings,
    });
  } catch (error) {
    throw new UIGraphError(
      "invalid_delta",
      `delta application produced an unsealable snapshot: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (sealed.snapshotId !== delta.targetSnapshotId || sealed.contentHash !== delta.targetContentHash) {
    throw new UIGraphError(
      "invalid_delta",
      "reconstructed snapshot does not match the delta's declared target identity",
    );
  }
  return sealed;
}
