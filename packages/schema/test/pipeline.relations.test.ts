import { describe, expect, it } from "vitest";
import { buildRelations, type FusedNode, type NodeHierarchy } from "@apature/ui-graph";
import type { Rect } from "@apature/ui-graph";

function geom(rect: Rect) {
  return { frameId: "root", frameRect: rect, documentRect: rect, viewportRect: rect, normalizedViewportRect: rect, coordinateSpaceId: "cs", visibility: "visible" as const, clipped: false };
}
function node(candidateId: string, rect: Rect): FusedNode {
  const n: FusedNode = { candidateId, kind: "dom", frameId: "root", evidence: [], flags: [], confidence: 0.9 };
  (n as { geometry?: ReturnType<typeof geom> }).geometry = geom(rect);
  return n;
}

/** Container + three stacked, left-aligned items in one region. */
function scene(): { nodes: FusedNode[]; hierarchy: NodeHierarchy[] } {
  const nodes = [
    node("root", { x: 0, y: 0, width: 400, height: 300 }),
    node("a", { x: 10, y: 10, width: 200, height: 40 }),
    node("b", { x: 10, y: 60, width: 200, height: 40 }),
    node("c", { x: 10, y: 110, width: 200, height: 40 }),
  ];
  const hierarchy: NodeHierarchy[] = [
    { candidateId: "root", regionIds: ["reg1"], depth: 0 },
    { candidateId: "a", parentNodeId: "root", regionIds: ["reg1"], depth: 1 },
    { candidateId: "b", parentNodeId: "root", regionIds: ["reg1"], depth: 1 },
    { candidateId: "c", parentNodeId: "root", regionIds: ["reg1"], depth: 1 },
  ];
  return { nodes, hierarchy };
}

describe("buildRelations", () => {
  it("emits contains from the hierarchy (directed, structural)", () => {
    const { edges } = buildRelations(scene().nodes, scene().hierarchy);
    const contains = edges.filter((e) => e.kind === "contains");
    expect(contains.map((e) => e.toNodeId).sort()).toEqual(["a", "b", "c"]);
    expect(contains.every((e) => e.directed && e.fromNodeId === "root")).toBe(true);
  });

  it("orders reading_next by geometry within a region", () => {
    const { edges } = buildRelations(scene().nodes, scene().hierarchy);
    const rn = edges.filter((e) => e.kind === "reading_next");
    expect(rn.some((e) => e.fromNodeId === "a" && e.toNodeId === "b")).toBe(true);
    expect(rn.some((e) => e.fromNodeId === "b" && e.toNodeId === "c")).toBe(true);
  });

  it("detects left alignment as aligned_start (symmetric, canonical ordering)", () => {
    const { edges } = buildRelations(scene().nodes, scene().hierarchy);
    const al = edges.filter((e) => e.kind === "aligned_start" && !e.directed);
    expect(al.length).toBeGreaterThan(0);
    for (const e of al) expect(e.fromNodeId < e.toNodeId).toBe(true); // canonical (min,max)
  });

  it("emits overlaps only above the IoU threshold", () => {
    const nodes = [node("x", { x: 0, y: 0, width: 100, height: 100 }), node("y", { x: 10, y: 10, width: 100, height: 100 })];
    const hierarchy: NodeHierarchy[] = [{ candidateId: "x", regionIds: [], depth: 0 }, { candidateId: "y", regionIds: [], depth: 0 }];
    expect(buildRelations(nodes, hierarchy, { iouThreshold: 0.1 }).edges.some((e) => e.kind === "overlaps")).toBe(true);
    expect(buildRelations(nodes, hierarchy, { iouThreshold: 0.99 }).edges.some((e) => e.kind === "overlaps")).toBe(false);
  });

  it("respects the per-node edge cap and never drops contains", () => {
    const { nodes, hierarchy } = scene();
    const capped = buildRelations(nodes, hierarchy, { maxPersistedEdgesPerNode: 2 });
    expect(capped.metrics.maxDegree).toBeLessThanOrEqual(2 + 3); // structural contains protected
    expect(capped.edges.some((e) => e.kind === "contains")).toBe(true); // hierarchy retained
    expect(capped.metrics.edges).toBe(capped.edges.length);
  });

  it("is deterministic (byte-identical edge set for identical input)", () => {
    const a = buildRelations(scene().nodes, scene().hierarchy);
    const b = buildRelations(scene().nodes, scene().hierarchy);
    expect(a).toEqual(b);
  });

  /**
   * Ordering-stability golden. Exercises both spread-copy → push seams with more
   * than one element (four siblings under one parent, several nodes sharing grid
   * cells) and pins the exact ordered edge set. Push preserves the same append
   * order as the old `[...(get() ?? []), x]`, so this output is byte-identical to
   * pre-change; any future regression that perturbs insertion/near ordering trips
   * here. (Region tag: `#O(n^2)` fix in SpatialGrid.insert / byParent.)
   */
  it("emits a byte-stable ordered edge set (multi-sibling, multi-cell scene)", () => {
    const nodes = [
      node("root", { x: 0, y: 0, width: 400, height: 400 }),
      node("a", { x: 10, y: 10, width: 200, height: 40 }),
      node("b", { x: 10, y: 60, width: 200, height: 40 }),
      node("c", { x: 10, y: 110, width: 200, height: 40 }),
      node("d", { x: 10, y: 160, width: 200, height: 40 }),
    ];
    const hierarchy: NodeHierarchy[] = [
      { candidateId: "root", regionIds: ["reg1"], depth: 0 },
      { candidateId: "a", parentNodeId: "root", regionIds: ["reg1"], depth: 1 },
      { candidateId: "b", parentNodeId: "root", regionIds: ["reg1"], depth: 1 },
      { candidateId: "c", parentNodeId: "root", regionIds: ["reg1"], depth: 1 },
      { candidateId: "d", parentNodeId: "root", regionIds: ["reg1"], depth: 1 },
    ];
    const { edges, metrics } = buildRelations(nodes, hierarchy);
    expect(metrics).toEqual({ edges: 23, maxDegree: 12 });
    expect(edges.map((e) => `${e.kind}:${e.fromNodeId}->${e.toNodeId}`)).toEqual([
      "reading_next:b->c",
      "aligned_center:b->c",
      "aligned_end:b->c",
      "aligned_end:a->b",
      "near:b->c",
      "contains:root->a",
      "aligned_center:a->b",
      "near:a->b",
      "aligned_start:b->c",
      "aligned_center:c->d",
      "near:c->root",
      "reading_next:c->d",
      "contains:root->c",
      "reading_next:a->b",
      "aligned_end:c->d",
      "near:d->root",
      "aligned_start:a->b",
      "contains:root->d",
      "contains:root->b",
      "near:c->d",
      "near:b->root",
      "aligned_start:c->d",
      "near:a->root",
    ]);
  });
});
