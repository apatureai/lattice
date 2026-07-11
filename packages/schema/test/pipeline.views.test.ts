import { describe, expect, it } from "vitest";
import {
  buildHierarchy,
  buildRelations,
  fuseCapture,
  normalizeCapture,
  renderActionMapView,
  renderFocusView,
  renderSummaryView,
  VIEW_POLICY_VERSION,
  type GraphView,
} from "@apature/ui-graph";
import { validCapture } from "./pipeline-fixtures.js";

/** A page with a small hierarchy and two interactive affordances. */
function graph(): GraphView {
  const capture = validCapture({
    documents: [
      {
        frameId: "root",
        domLayoutNodes: [
          { sourceId: "page", frameId: "root", visible: true, bounds: { x: 0, y: 0, width: 1000, height: 800 } },
          { sourceId: "header", parentSourceId: "page", frameId: "root", visible: true, bounds: { x: 0, y: 0, width: 1000, height: 80 } },
          { sourceId: "cta", parentSourceId: "header", frameId: "root", visible: true, bounds: { x: 800, y: 20, width: 160, height: 40 } },
          { sourceId: "main", parentSourceId: "page", frameId: "root", visible: true, bounds: { x: 0, y: 80, width: 1000, height: 640 } },
          { sourceId: "card", parentSourceId: "main", frameId: "root", visible: true, bounds: { x: 40, y: 120, width: 300, height: 200 } },
          { sourceId: "cardlink", parentSourceId: "card", frameId: "root", visible: true, bounds: { x: 60, y: 280, width: 120, height: 24 } },
          { sourceId: "footer", parentSourceId: "page", frameId: "root", visible: true, bounds: { x: 0, y: 720, width: 1000, height: 80 } },
        ],
        accessibilityNodes: [
          { sourceId: "ax_cta", frameId: "root", ignored: false, backendDomSourceId: "cta", role: "button", name: "Start free trial" },
          { sourceId: "ax_link", frameId: "root", ignored: false, backendDomSourceId: "cardlink", role: "link", name: "Learn more" },
        ],
        textRuns: [
          { sourceId: "t1", frameId: "root", text: "Pricing", bounds: { x: 20, y: 30, width: 100, height: 20 } },
        ],
      },
    ],
  });
  const fusion = fuseCapture(capture, normalizeCapture(capture));
  const hier = buildHierarchy(fusion.nodes);
  const rel = buildRelations(fusion.nodes, hier.hierarchy);
  return { nodes: fusion.nodes, hierarchy: hier.hierarchy, regions: hier.regions, edges: rel.edges };
}

function buttonId(g: GraphView): string {
  const node = g.nodes.find((n) => n.role?.value === "button");
  expect(node).toBeDefined();
  return node!.candidateId;
}

describe("renderFocusView (#41, PRD §6.4)", () => {
  it("is deterministic: the same graph renders a byte-identical view", () => {
    const g = graph();
    const ref = buttonId(g);
    const a = renderFocusView(g, [ref]);
    const b = renderFocusView(g, [ref]);
    expect(a.text).toBe(b.text);
    expect(a.meta).toEqual(b.meta);
    expect(a.meta.policyVersion).toBe(VIEW_POLICY_VERSION);
    expect(a.meta.tokenEstimate).toBe(Math.ceil(a.text.length / 4));
    expect(a.meta.refsResolved).toEqual([ref]);
    expect(a.meta.truncated).toBe(false);
  });

  it("bounds the neighborhood by radius and reports what a budget cuts", () => {
    const g = graph();
    const ref = buttonId(g);
    const wide = renderFocusView(g, [ref], { radius: 4 });
    const narrow = renderFocusView(g, [ref], { radius: 4, budget: { maxNodes: 2 } });
    expect(narrow.meta.truncated).toBe(true);
    expect(narrow.meta.omitted.nodes).toBeGreaterThan(0);
    expect(narrow.text.length).toBeLessThan(wide.text.length);
    // Wider radius sees at least as much as radius 0.
    const solo = renderFocusView(g, [ref], { radius: 0 });
    expect(wide.text.length).toBeGreaterThan(solo.text.length);
  });

  it("fails closed on unresolved refs: explicit empty view, never a guess", () => {
    const g = graph();
    const view = renderFocusView(g, ["ug_nonexistent_1", "ug_nonexistent_2"]);
    expect(view.text).toBe("");
    expect(view.meta.emptyReason).toMatch(/refusing to guess/);
    expect(view.meta.refsUnresolved).toEqual(["ug_nonexistent_1", "ug_nonexistent_2"]);
    expect(view.meta.tokenEstimate).toBe(0);
    // A mixed call still renders: unresolved refs are reported, not fatal.
    const mixed = renderFocusView(g, [buttonId(g), "ug_nonexistent_1"]);
    expect(mixed.text.length).toBeGreaterThan(0);
    expect(mixed.meta.refsUnresolved).toEqual(["ug_nonexistent_1"]);
  });
});

describe("renderSummaryView (#41, PRD §6.4)", () => {
  it("carries regions, shallow hierarchy, affordances, and caveats verbatim", () => {
    const g = graph();
    const caveat = "Page health: 1 console error during capture.";
    const view = renderSummaryView(g, { caveats: [caveat] });
    expect(view.text).toContain(caveat);
    expect(view.text).toContain("button");
    expect(view.text).toContain("link");
    expect(view.meta.view).toBe("summary");
    expect(view.meta.truncated).toBe(false);
  });

  it("caps affordances with truncation metadata, deterministically", () => {
    const g = graph();
    const capped = renderSummaryView(g, { maxAffordances: 1 });
    expect(capped.meta.truncated).toBe(true);
    expect(capped.meta.omitted.nodes).toBe(1); // two affordances, one kept
    const again = renderSummaryView(g, { maxAffordances: 1 });
    expect(again.text).toBe(capped.text);
  });
});

describe("renderActionMapView (#16, PRD §6.4)", () => {
  it("lists visible interactive refs with role/name/rect/state, deterministically", () => {
    const g = graph();
    const a = renderActionMapView(g, { snapshotId: "snap_1" });
    const b = renderActionMapView(g, { snapshotId: "snap_1" });
    expect(a.text).toBe(b.text); // byte-identical over the same graph
    expect(a.meta).toEqual(b.meta);
    expect(a.meta.view).toBe("actionMap");
    expect(a.meta.policyVersion).toBe(VIEW_POLICY_VERSION);
    expect(a.meta.tokenEstimate).toBe(Math.ceil(a.text.length / 4));

    // The two interactive affordances appear; refs are the synthetic candidate ids.
    expect(a.meta.refsResolved).toEqual([...a.meta.refsResolved].sort());
    expect(a.meta.refsResolved).toHaveLength(2);
    expect(a.text).toContain("button");
    expect(a.text).toContain("link");
    expect(a.text).toContain("Start free trial");
    expect(a.text).toContain("\"visibility\":\"visible\"");
    expect(a.text).toContain("snap_1");
  });

  it("is perception-only: no action commands, no browser handles, no raw source ids", () => {
    const g = graph();
    const view = renderActionMapView(g);
    expect(view.text).toContain("\"perceptionOnly\":true");
    // Raw source ids / AX ids live only in node.evidence and must never leak.
    for (const leak of ["ax_cta", "ax_link", "backendDomSourceId", "sourceId", "cardlink"]) {
      expect(view.text).not.toContain(leak);
    }
    // No command/action verbs or browser-handle keys in the emitted structure.
    for (const verb of ["\"click\"", "\"type\"", "\"press\"", "\"navigate\"", "capture_session", "command"]) {
      expect(view.text).not.toContain(verb);
    }
  });

  it("excludes non-interactive nodes and elements without an on-screen rect", () => {
    const g = graph();
    const refs = renderActionMapView(g).meta.refsResolved;
    // Only the button + link are interactive; page/header/main/card/footer are not.
    const interactiveIds = g.nodes
      .filter((n) => n.role?.value === "button" || n.role?.value === "link")
      .map((n) => n.candidateId)
      .sort();
    expect(refs).toEqual(interactiveIds);
  });

  it("stays within budget or reports truncation, deterministically", () => {
    const g = graph();
    const capped = renderActionMapView(g, { budget: { maxNodes: 1 } });
    expect(capped.meta.truncated).toBe(true);
    expect(capped.meta.omitted.nodes).toBe(1);
    expect(capped.meta.refsResolved).toHaveLength(1);
    const again = renderActionMapView(g, { budget: { maxNodes: 1 } });
    expect(again.text).toBe(capped.text);
  });
});
