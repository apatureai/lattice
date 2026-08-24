import { describe, expect, it } from "vitest";
import { heuristicSaliency, rankBySaliency, type FusedNode } from "@apatureai/lattice";
import type { Rect } from "@apatureai/lattice";

function geom(rect: Rect) {
  return { frameId: "root", frameRect: rect, documentRect: rect, viewportRect: rect, normalizedViewportRect: rect, coordinateSpaceId: "cs", visibility: "visible" as const, clipped: false };
}
function node(candidateId: string, rect: Rect | undefined, role?: string): FusedNode {
  const n: FusedNode = { candidateId, kind: "dom", frameId: "root", evidence: [], flags: [], confidence: 0.9 };
  if (rect !== undefined) (n as { geometry?: ReturnType<typeof geom> }).geometry = geom(rect);
  if (role !== undefined) (n as { role?: { value: string; confidence: number; conflict: boolean } }).role = { value: role, confidence: 0.9, conflict: false };
  return n;
}

const VP = { width: 1000, height: 1000 };

describe("heuristicSaliency", () => {
  it("scores a top-center heading higher than a small bottom-corner element", () => {
    const nodes = [
      node("hero", { x: 300, y: 0, width: 400, height: 120 }, "heading"),
      node("footer_link", { x: 940, y: 960, width: 40, height: 20 }, "link"),
    ];
    const s = heuristicSaliency(nodes, VP);
    const hero = s.find((x) => x.candidateId === "hero")!.saliency;
    const foot = s.find((x) => x.candidateId === "footer_link")!.saliency;
    expect(hero).toBeGreaterThan(foot);
    expect(hero).toBeGreaterThan(0);
    expect(hero).toBeLessThanOrEqual(1);
  });

  it("gives a geometry-less node a small advisory floor, never zero-crashing", () => {
    const s = heuristicSaliency([node("ax_only", undefined, "status")], VP);
    expect(s[0]?.saliency).toBeGreaterThan(0);
    expect(s[0]?.saliency).toBeLessThan(0.3);
  });

  it("weights attention-drawing roles higher, all else equal", () => {
    const rect = { x: 400, y: 400, width: 100, height: 40 };
    const heading = heuristicSaliency([node("h", rect, "heading")], VP)[0]!.saliency;
    const generic = heuristicSaliency([node("g", rect, "generic")], VP)[0]!.saliency;
    expect(heading).toBeGreaterThan(generic);
  });

  it("treats a prototype-chain role as unknown, never NaN or a function weight", () => {
    // `constructor`/`__proto__`/`toString`/`valueOf` must not resolve through the
    // ROLE_WEIGHT map's prototype: they are unknown roles, weighted at the 0.3
    // default exactly like any other unrecognized role, never an inherited
    // function/object that poisons the arithmetic with NaN.
    const rect = { x: 400, y: 400, width: 100, height: 40 };
    const generic = heuristicSaliency([node("g", rect, "totally-unknown-role")], VP)[0]!.saliency;
    for (const role of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      // both the geometry and geometry-less branches read roleWeight
      const withGeom = heuristicSaliency([node("g", rect, role)], VP)[0]!.saliency;
      const noGeom = heuristicSaliency([node("g", undefined, role)], VP)[0]!.saliency;
      expect(Number.isFinite(withGeom)).toBe(true);
      expect(Number.isFinite(noGeom)).toBe(true);
      expect(withGeom).toBe(generic); // same as an ordinary unknown role
    }
  });

  it("is deterministic and order-stable", () => {
    const nodes = [node("b", { x: 0, y: 0, width: 100, height: 100 }), node("a", { x: 500, y: 500, width: 50, height: 50 })];
    expect(heuristicSaliency(nodes, VP)).toEqual(heuristicSaliency([...nodes].reverse(), VP));
  });
});

describe("rankBySaliency", () => {
  it("orders most- to least-salient, ties broken by id", () => {
    const ranked = rankBySaliency([
      { candidateId: "z", saliency: 0.5 },
      { candidateId: "a", saliency: 0.5 },
      { candidateId: "top", saliency: 0.9 },
    ]);
    expect(ranked).toEqual(["top", "a", "z"]);
  });
});
