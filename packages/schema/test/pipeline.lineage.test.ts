import { describe, expect, it } from "vitest";
import { matchNodes, renderDiffView, type DiffComparison } from "@apature/ui-graph";
import type { LocatorHint, UIGraphNode } from "@apature/ui-graph";

function node(over: Partial<UIGraphNode> & { nodeId: string; elementRef: string }): UIGraphNode {
  return {
    kind: "control",
    regionIds: [],
    semantics: { states: {} },
    geometry: { frameId: "root", clipped: false, normalizedViewportRect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } },
    style: {},
    affordances: [],
    dnaMatches: [],
    locatorHints: [],
    evidence: [],
    sensitivity: ["public"],
    confidence: 0.9,
    flags: [],
    ...over,
  };
}

function tid(value: string): LocatorHint {
  return { kind: "explicit_test_id", value, scope: "route_version", uniqueness: 1, stability: 1, confidence: 1 };
}

const comparison: DiffComparison = {
  baseSnapshotId: "snap_a",
  baseContentHash: "sha256:a",
  targetSnapshotId: "snap_b",
  targetContentHash: "sha256:b",
};

describe("matchNodes — abstaining cross-snapshot lineage (#13)", () => {
  it("matches a node that keeps its stable id + role + geometry", () => {
    const base = [node({ nodeId: "b1", elementRef: "el_cta", semantics: { role: "button", name: "Buy", states: {} }, locatorHints: [tid("cta")] })];
    const target = [node({ nodeId: "t1", elementRef: "el_cta", semantics: { role: "button", name: "Buy", states: {} }, locatorHints: [tid("cta")] })];
    const [m] = matchNodes(base, target);
    expect(m!.status).toBe("matched");
    expect(m!.targetNodeId).toBe("t1");
    expect(m!.score).toBeGreaterThanOrEqual(0.7);
    expect(m!.features.some((f) => f.name === "explicit_id" && f.score === 1)).toBe(true);
  });

  it("abstains (never mis-points) when two target candidates are equally plausible", () => {
    // A base with only weak generic signal against two identical targets.
    const base = [node({ nodeId: "b1", elementRef: "el", semantics: { role: "listitem", states: {} } })];
    const target = [
      node({ nodeId: "t1", elementRef: "el_a", semantics: { role: "listitem", states: {} } }),
      node({ nodeId: "t2", elementRef: "el_b", semantics: { role: "listitem", states: {} } }),
    ];
    const [m] = matchNodes(base, target);
    // Either it clears threshold but the two are too close (ambiguous), or it is
    // below threshold (abstained). In NO case does it point to a specific target.
    expect(["ambiguous", "abstained"]).toContain(m!.status);
    expect(m!.targetNodeId).toBeUndefined();
  });

  it("reports a removed node when nothing in the target resembles it", () => {
    const base = [node({ nodeId: "b1", elementRef: "gone", kind: "image", semantics: { role: "img", name: "hero", states: {} }, locatorHints: [tid("hero")] })];
    const target = [node({ nodeId: "t1", elementRef: "el", kind: "text", semantics: { role: "paragraph", name: "totally other", states: {} } })];
    const [m] = matchNodes(base, target);
    expect(m!.status).toBe("removed");
  });

  it("is one-to-one and deterministic: a target is claimed by only its best base", () => {
    const base = [
      node({ nodeId: "b1", elementRef: "el1", semantics: { role: "button", name: "Save", states: {} }, locatorHints: [tid("save")] }),
      node({ nodeId: "b2", elementRef: "el2", semantics: { role: "button", name: "Save", states: {} } }),
    ];
    const target = [node({ nodeId: "t1", elementRef: "el1", semantics: { role: "button", name: "Save", states: {} }, locatorHints: [tid("save")] })];
    const a = matchNodes(base, target);
    const b = matchNodes(base, target);
    expect(a).toEqual(b);
    const matched = a.filter((m) => m.status === "matched");
    expect(matched).toHaveLength(1);
    expect(matched[0]!.baseNodeId).toBe("b1"); // the stable-id base wins the target
  });
});

describe("renderDiffView (#13)", () => {
  it("requires a comparison id + content hash for both sides (fail-closed)", () => {
    const view = renderDiffView([], [], { baseSnapshotId: "", baseContentHash: "", targetSnapshotId: "", targetContentHash: "" });
    expect(view.text).toBe("");
    expect(view.meta.emptyReason).toMatch(/requires a comparison snapshot id and content hash/);
  });

  it("classifies a sub-jitter positional change as capture instability, not product change", () => {
    const base = [node({ nodeId: "b1", elementRef: "el", locatorHints: [tid("x")], geometry: { frameId: "root", clipped: false, normalizedViewportRect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } } })];
    const target = [node({ nodeId: "t1", elementRef: "el", locatorHints: [tid("x")], geometry: { frameId: "root", clipped: false, normalizedViewportRect: { x: 0.101, y: 0.1, width: 0.2, height: 0.1 } } })];
    const view = renderDiffView(base, target, comparison);
    const parsed = JSON.parse(view.text) as { matched: { changeKind: string }[] };
    expect(parsed.matched[0]!.changeKind).toBe("capture_instability");
  });

  it("classifies a style/semantic change as a product change, and reports added/removed", () => {
    const base = [
      node({ nodeId: "b1", elementRef: "el", locatorHints: [tid("x")], style: { color: "#000000" } }),
      node({ nodeId: "b2", elementRef: "old", kind: "image", semantics: { role: "img", name: "banner", states: {} }, locatorHints: [tid("banner")] }),
    ];
    const target = [
      node({ nodeId: "t1", elementRef: "el", locatorHints: [tid("x")], style: { color: "#ff0000" } }), // recolored
      node({ nodeId: "t2", elementRef: "brand_new", kind: "text", semantics: { role: "note", name: "fresh", states: {} } }),
    ];
    const view = renderDiffView(base, target, comparison);
    const parsed = JSON.parse(view.text) as { matched: { targetRef: string; changeKind: string; changed: { style: boolean } }[]; added: string[]; removed: string[] };
    const recolored = parsed.matched.find((m) => m.targetRef === "el")!;
    expect(recolored.changeKind).toBe("product_change");
    expect(recolored.changed.style).toBe(true);
    expect(parsed.added).toContain("brand_new");
    expect(parsed.removed).toContain("old");
  });

  it("is deterministic: same snapshots ⇒ byte-identical diff", () => {
    const base = [node({ nodeId: "b1", elementRef: "el", locatorHints: [tid("x")] })];
    const target = [node({ nodeId: "t1", elementRef: "el", locatorHints: [tid("x")] })];
    expect(renderDiffView(base, target, comparison).text).toBe(renderDiffView(base, target, comparison).text);
  });
});
