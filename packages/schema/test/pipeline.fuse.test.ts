import { describe, expect, it } from "vitest";

import { fuseCapture, normalizeCapture, type CaptureBundleReadProfile } from "@apatureai/lattice";

/**
 * A capture exercising every fusion path: a DOM node, a backend-linked AX node
 * that DISAGREES on role, a linked text run, an AX-only node, and two visual
 * candidates (one overlapping the DOM node, one not).
 */
function capture(): CaptureBundleReadProfile {
  return {
    schemaVersion: "1.0.0",
    captureId: "cap_1",
    captureVersion: "1",
    repository: { owner: "acme", name: "web" },
    route: "/",
    viewport: { widthCssPx: 1000, heightCssPx: 800, deviceScaleFactor: 1, scrollXCssPx: 0, scrollYCssPx: 0 },
    documents: [
      {
        frameId: "root",
        domLayoutNodes: [
          { sourceId: "d1", frameId: "root", role: "button", tag: "div", visible: true, bounds: { x: 0, y: 0, width: 100, height: 50 } },
          { sourceId: "d2", frameId: "root", role: "tooltip", tag: "span", visible: false, bounds: { x: 0, y: 200, width: 40, height: 20 } },
        ],
        accessibilityNodes: [
          { sourceId: "a1", frameId: "root", role: "link", name: "Submit", ignored: false, backendDomSourceId: "d1" },
          { sourceId: "a2", frameId: "root", role: "status", name: "Loading", ignored: false },
        ],
        textRuns: [{ sourceId: "t1", frameId: "root", text: "Submit", domSourceId: "d1", bounds: { x: 5, y: 5, width: 90, height: 16 } }],
      },
    ],
    screenshotEvidence: [{ artifactRef: "uiart:shot/1", frameId: "root", widthImagePx: 1000, heightImagePx: 800, deviceScaleFactor: 1 }],
    pageHealth: { stable: true, partial: false, reasons: [] },
    redaction: { policyVersion: "1", applied: false, redactedSourceIds: [] },
    derivedObservations: [
      {
        kind: "vision_parser",
        provider: "vp",
        providerVersion: "1",
        sourceImageRef: "uiart:shot/1",
        elements: [
          { sourceId: "v1", rectImagePx: { x: 0, y: 0, width: 100, height: 50 }, class: "button", text: "Submit", confidence: 0.7 },
          { sourceId: "v2", rectImagePx: { x: 600, y: 600, width: 20, height: 20 }, class: "icon", confidence: 0.6 },
        ],
      },
    ],
  };
}

function fuse(c = capture(), options = {}) {
  return fuseCapture(c, normalizeCapture(c), options);
}

describe("fuseCapture", () => {
  it("retains conflicting AX/DOM role claims, flags the conflict, and lowers confidence", () => {
    const { nodes, warnings } = fuse();
    const d1 = nodes.find((n) => n.evidence.some((e) => e.sourceId === "d1"))!;
    // Both the DOM ('button') and AX ('link') role claims are kept as evidence.
    const roleClaims = d1.evidence.flatMap((e) => e.claims).filter((c) => c.startsWith("role="));
    expect(roleClaims).toEqual(expect.arrayContaining(["role=button", "role=link"]));
    expect(d1.role?.conflict).toBe(true);
    expect(d1.flags).toContain("conflict:role");
    expect(d1.role?.confidence).toBeLessThan(0.85); // lowered from the AX base
    expect(warnings.some((w) => w.code === "source_conflict")).toBe(true);
  });

  it("decides role per-fact competence (AX wins role) without a global ranking", () => {
    const d1 = fuse().nodes.find((n) => n.evidence.some((e) => e.sourceId === "d1"))!;
    expect(d1.role?.value).toBe("link"); // accessibility is more competent for role
    expect(d1.text?.value).toBe("Submit"); // text run is more competent for text
  });

  it("never exposes raw source ids as the node id (they live only in evidence)", () => {
    const nodes = fuse().nodes;
    for (const n of nodes) {
      expect(n.candidateId).toMatch(/^cand_\d{4}$/);
      expect(["d1", "d2", "a1", "a2", "t1", "v1", "v2"]).not.toContain(n.candidateId);
    }
  });

  it("fuses a backend-linked AX node and a linked text run into one DOM candidate", () => {
    const nodes = fuse().nodes;
    const withD1 = nodes.filter((n) => n.evidence.some((e) => e.sourceId === "d1"));
    expect(withD1).toHaveLength(1);
    const node = withD1[0]!;
    expect(node.evidence.some((e) => e.sourceId === "a1")).toBe(true); // AX fused in
    expect(node.evidence.some((e) => e.sourceId === "t1")).toBe(true); // text fused in
  });

  it("keeps an AX-only node (no visible counterpart) as its own candidate", () => {
    const node = fuse().nodes.find((n) => n.evidence.some((e) => e.sourceId === "a2"));
    expect(node?.kind).toBe("ax_only");
    expect(node?.role?.value).toBe("status");
  });

  it("fuses an overlapping visual candidate but keeps a non-overlapping one standalone", () => {
    const nodes = fuse().nodes;
    const d1 = nodes.find((n) => n.evidence.some((e) => e.sourceId === "d1"))!;
    expect(d1.evidence.some((e) => e.sourceId === "v1")).toBe(true); // overlapping → fused
    const standalone = nodes.find((n) => n.evidence.some((e) => e.sourceId === "v2"));
    expect(standalone?.kind).toBe("visual");
    expect(standalone?.evidence.some((e) => e.sourceId === "d1")).toBe(false);
    expect(standalone?.geometry).toMatchObject({
      frameId: "root",
      viewportRect: { x: 600, y: 600, width: 20, height: 20 },
      coordinateSpaceId: "cs_frame_root",
      visibility: "visible",
    });
    expect(standalone?.evidence[0]).toMatchObject({
      artifactRef: "uiart:shot/1",
      coordinateSpaceId: "cs_frame_root",
    });
  });

  it("excludes hidden DOM nodes unless explanatory nodes are enabled", () => {
    expect(fuse().nodes.some((n) => n.evidence.some((e) => e.sourceId === "d2"))).toBe(false);
    const withHidden = fuse(capture(), { includeHiddenExplanatoryNodes: true });
    const d2 = withHidden.nodes.find((n) => n.evidence.some((e) => e.sourceId === "d2"));
    expect(d2?.flags).toContain("hidden_explanatory");
  });

  it("is deterministic for byte-identical input", () => {
    expect(fuse()).toEqual(fuse());
  });
});
