import { describe, expect, it } from "vitest";
import { buildHierarchy, type FusedNode } from "@apature/ui-graph";
import type { Rect } from "@apature/ui-graph";

function geom(rect: Rect, visibility: "visible" | "hidden" = "visible") {
  return { frameId: "root", frameRect: rect, documentRect: rect, viewportRect: rect, normalizedViewportRect: rect, coordinateSpaceId: "cs", visibility, clipped: false };
}

function node(candidateId: string, rect: Rect | undefined, role?: string, name?: string): FusedNode {
  const n: FusedNode = { candidateId, kind: "dom", frameId: "root", evidence: [], flags: [], confidence: 0.9 };
  if (rect !== undefined) (n as { geometry?: ReturnType<typeof geom> }).geometry = geom(rect);
  if (role !== undefined) (n as { role?: { value: string; confidence: number; conflict: boolean } }).role = { value: role, confidence: 0.9, conflict: false };
  if (name !== undefined) (n as { name?: { value: string; confidence: number; conflict: boolean } }).name = { value: name, confidence: 0.9, conflict: false };
  return n;
}

/** A page: main landmark > (navigation, list) ; list > 4 same-size listitems. */
function scene(): FusedNode[] {
  const items = Array.from({ length: 4 }, (_, i) => node(`c_i${i}`, { x: 0, y: 60 + i * 50, width: 280, height: 40 }, "listitem"));
  return [
    node("c_root", { x: 0, y: 0, width: 1000, height: 800 }, "main"),
    node("c_nav", { x: 0, y: 0, width: 1000, height: 50 }, "navigation", "Primary"),
    node("c_list", { x: 0, y: 60, width: 300, height: 400 }, "list"),
    ...items,
  ];
}

describe("buildHierarchy", () => {
  it("assigns parents by smallest enclosing geometry", () => {
    const { hierarchy } = buildHierarchy(scene());
    const h = (id: string) => hierarchy.find((n) => n.candidateId === id);
    expect(h("c_root")?.parentNodeId).toBeUndefined(); // root
    expect(h("c_nav")?.parentNodeId).toBe("c_root");
    expect(h("c_list")?.parentNodeId).toBe("c_root");
    expect(h("c_i0")?.parentNodeId).toBe("c_list"); // list is the smallest enclosing
  });

  it("promotes landmark / list roles to regions referencing valid members + root", () => {
    const { regions } = buildHierarchy(scene());
    const nav = regions.find((r) => r.kind === "landmark" && r.rootNodeId === "c_nav");
    expect(nav?.label).toBe("Primary");
    const list = regions.find((r) => r.kind === "list");
    expect(list?.rootNodeId).toBe("c_list");
    expect(list?.summary.itemCount).toBe(4);
    // Every region references a real root + members.
    const ids = new Set(scene().map((n) => n.candidateId));
    for (const r of regions) {
      expect(ids.has(r.rootNodeId)).toBe(true);
      for (const m of r.memberNodeIds) expect(ids.has(m)).toBe(true);
    }
  });

  it("detects a repeated region with a stable repeatedPatternHash + counts", () => {
    const a = buildHierarchy(scene());
    const b = buildHierarchy(scene());
    const repA = a.regions.find((r) => r.kind === "repeated");
    const repB = b.regions.find((r) => r.kind === "repeated");
    expect(repA?.summary.itemCount).toBe(4);
    expect(repA?.summary.visibleItemCount).toBe(4);
    expect(repA?.summary.repeatedPatternHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(repA?.summary.repeatedPatternHash).toBe(repB?.summary.repeatedPatternHash); // stable
  });

  it("does not form a repeated region below the threshold", () => {
    const few = [
      node("c_list", { x: 0, y: 0, width: 300, height: 200 }, "list"),
      node("c_a", { x: 0, y: 10, width: 280, height: 40 }, "listitem"),
      node("c_b", { x: 0, y: 60, width: 280, height: 40 }, "listitem"),
    ];
    expect(buildHierarchy(few).regions.some((r) => r.kind === "repeated")).toBe(false); // only 2 < 3
  });

  it("summarizes repeated regions under the node cap, never the required hierarchy", () => {
    const { truncation, regions, hierarchy } = buildHierarchy(scene(), { maxNodes: 4 });
    expect(truncation.truncated).toBe(true);
    const rep = regions.find((r) => r.kind === "repeated")!;
    expect(truncation.summarizedRegionIds).toContain(rep.regionId);
    expect(truncation.omittedNodeCount).toBe(3); // 4 items -> keep 1
    expect(hierarchy).toHaveLength(4);
    expect(hierarchy.every((entry) => entry.parentNodeId === undefined || hierarchy.some((parent) => parent.candidateId === entry.parentNodeId))).toBe(true);
    // Landmark/list regions are never summarized away.
    const nav = regions.find((r) => r.kind === "landmark" && r.rootNodeId === "c_nav")!;
    expect(truncation.summarizedRegionIds).not.toContain(nav.regionId);
  });

  it("retains all nodes when under the cap", () => {
    const { truncation, hierarchy } = buildHierarchy(scene(), { maxNodes: 100 });
    expect(truncation.truncated).toBe(false);
    expect(hierarchy).toHaveLength(7);
  });

  it("attaches a geometry-less node at a frame root", () => {
    const nodes = [node("c_root", { x: 0, y: 0, width: 100, height: 100 }), node("c_ax", undefined, "status")];
    const h = buildHierarchy(nodes).hierarchy.find((n) => n.candidateId === "c_ax");
    expect(h?.parentNodeId).toBeUndefined();
  });
});
