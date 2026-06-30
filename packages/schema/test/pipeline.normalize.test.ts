import { describe, expect, it } from "vitest";

import { normalizeCapture, rectsWithinTolerance, validateAndNormalize } from "@apature/ui-graph";

import { validCapture } from "./pipeline-fixtures.js";

describe("normalizeCapture", () => {
  it("emits all five coordinate-space kinds when a screenshot is present", () => {
    const c = validCapture({
      screenshotEvidence: [
        { artifactRef: "uiart:img/1", frameId: "root", widthImagePx: 2000, heightImagePx: 1600, deviceScaleFactor: 2 },
      ],
    });
    const { coordinateSpaces } = normalizeCapture(c);
    const kinds = new Set(coordinateSpaces.map((s) => s.kind));
    expect(kinds).toEqual(new Set(["document_css", "viewport_css", "frame_css", "image_px", "normalized"]));
  });

  it("resolves every geometry-bearing node to an existing coordinate space", () => {
    const { coordinateSpaces, nodes } = normalizeCapture(validCapture());
    const spaceIds = new Set(coordinateSpaces.map((s) => s.coordinateSpaceId));
    for (const n of nodes) {
      if (n.geometry) expect(spaceIds.has(n.geometry.coordinateSpaceId)).toBe(true);
    }
  });

  it("maps a root-frame node to document space identically (within tolerance)", () => {
    const { nodes } = normalizeCapture(validCapture());
    const d1 = nodes.find((n) => n.sourceId === "d1");
    expect(d1?.geometry).toBeDefined();
    expect(rectsWithinTolerance(d1!.geometry!.documentRect, { x: 0, y: 0, width: 100, height: 50 })).toBe(true);
  });

  it("composes a child-frame transform into document space", () => {
    const c = validCapture();
    c.documents.push({
      frameId: "child",
      parentFrameId: "root",
      transformToParent: [1, 0, 0, 1, 100, 50],
      domLayoutNodes: [{ sourceId: "c1", frameId: "child", visible: true, bounds: { x: 0, y: 0, width: 10, height: 10 } }],
      accessibilityNodes: [],
    });
    const { nodes } = normalizeCapture(c);
    const c1 = nodes.find((n) => n.sourceId === "c1");
    // frame-local (0,0) shifts to document (100,50) via the frame transform.
    expect(rectsWithinTolerance(c1!.geometry!.documentRect, { x: 100, y: 50, width: 10, height: 10 })).toBe(true);
  });

  it("applies viewport scroll to the viewport rect", () => {
    const c = validCapture();
    c.viewport.scrollYCssPx = 200;
    const { nodes } = normalizeCapture(c);
    const d1 = nodes.find((n) => n.sourceId === "d1");
    // documentRect.y = 0, scrolled 200 → viewportRect.y = -200.
    expect(rectsWithinTolerance(d1!.geometry!.viewportRect, { x: 0, y: -200, width: 100, height: 50 })).toBe(true);
  });

  it("classifies visibility and clipping against the viewport", () => {
    const c = validCapture();
    c.documents[0]!.domLayoutNodes.push(
      { sourceId: "hidden", frameId: "root", visible: false, bounds: { x: 0, y: 0, width: 10, height: 10 } },
      { sourceId: "off", frameId: "root", visible: true, bounds: { x: 5000, y: 5000, width: 10, height: 10 } },
      { sourceId: "edge", frameId: "root", visible: true, bounds: { x: 990, y: 0, width: 40, height: 40 } },
    );
    const { nodes } = normalizeCapture(c);
    const by = (id: string) => nodes.find((n) => n.sourceId === id)!.geometry!;
    expect(by("d1").visibility).toBe("visible");
    expect(by("hidden").visibility).toBe("hidden");
    expect(by("off").visibility).toBe("offscreen");
    expect(by("edge").visibility).toBe("clipped");
    expect(by("edge").clipped).toBe(true);
  });

  it("normalizes match text but keeps redacted runs out of the key", () => {
    const c = validCapture();
    c.redaction.redactedSourceIds = ["t1"];
    const original = c.documents[0]!.textRuns![0]!.text;
    const { nodes } = normalizeCapture(c);
    const t1 = nodes.find((n) => n.sourceId === "t1");
    expect(t1?.text?.display).toBe(original); // display preserved verbatim
    expect(t1?.text?.matchKey).toBe(""); // redacted → empty key
    expect(t1?.text?.redacted).toBe(true);
  });

  it("collapses whitespace and case for a non-redacted match key", () => {
    const { nodes } = normalizeCapture(validCapture());
    const t1 = nodes.find((n) => n.sourceId === "t1");
    expect(t1?.text?.matchKey).toBe("hello world");
  });

  it("normalizes style colors and lengths while preserving originals", () => {
    const { nodes } = normalizeCapture(validCapture());
    const d1 = nodes.find((n) => n.sourceId === "d1")!;
    expect(d1.colors.color?.original).toBe("#fff");
    expect(d1.colors.color?.canonical).toBe("#ffffff");
    expect(d1.colors.backgroundColor?.canonical).toBe("#000000");
    expect(d1.lengths.fontSizeCssPx?.valueCssPx).toBe(16);
    expect(d1.lengths.padding?.original).toBe("1rem");
    expect(d1.lengths.padding?.valueCssPx).toBeNull(); // rem unresolved without layout context
  });

  it("degrades a frame-transform cycle to a warning, never throwing", () => {
    const c = validCapture();
    c.documents = [
      { frameId: "a", parentFrameId: "b", transformToParent: [1, 0, 0, 1, 0, 0], domLayoutNodes: [], accessibilityNodes: [] },
      { frameId: "b", parentFrameId: "a", transformToParent: [1, 0, 0, 1, 0, 0], domLayoutNodes: [], accessibilityNodes: [] },
    ];
    const res = normalizeCapture(c);
    expect(res.warnings.some((w) => w.code === "invalid_transform")).toBe(true);
  });

  it("validateAndNormalize fails closed and yields no normalized output on error", () => {
    const bad = validCapture({ schemaVersion: "9.9.9" });
    const r = validateAndNormalize(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect("normalized" in r).toBe(false);
  });
});
