import { describe, expect, it } from "vitest";

import { validateCapture, type CaptureBundleReadProfile } from "@apature/ui-graph";

import { validCapture } from "./pipeline-fixtures.js";

/** Codes present in an `ok: false` result. */
function codes(capture: CaptureBundleReadProfile): string[] {
  const r = validateCapture(capture);
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe("validateCapture", () => {
  it("accepts a well-formed capture", () => {
    const r = validateCapture(validCapture());
    expect(r.ok).toBe(true);
  });

  it("rejects an unsupported capture schema major", () => {
    expect(codes(validCapture({ schemaVersion: "2.0.0" }))).toContain("unsupported_capture_major");
  });

  it("rejects NaN / Infinity geometry with no partial output", () => {
    const nan = validCapture();
    nan.documents[0]!.domLayoutNodes[0]!.bounds = { x: Number.NaN, y: 0, width: 10, height: 10 };
    const r = validateCapture(nan);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.code)).toContain("non_finite_geometry");
    // Fail-closed: no `capture` field leaks on the error result.
    expect("capture" in r).toBe(false);

    const inf = validCapture();
    inf.documents[0]!.domLayoutNodes[0]!.bounds = { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 };
    expect(codes(inf)).toContain("non_finite_geometry");
  });

  it("rejects overflow geometry distinctly from non-finite", () => {
    const c = validCapture();
    c.documents[0]!.domLayoutNodes[0]!.bounds = { x: 0, y: 0, width: 1e9, height: 10 };
    expect(codes(c)).toContain("geometry_overflow");
  });

  it("rejects duplicate source IDs across observation types", () => {
    const c = validCapture();
    c.documents[0]!.accessibilityNodes[0]!.sourceId = "d1"; // collide with a dom node
    expect(codes(c)).toContain("duplicate_source_id");
  });

  it("rejects a cyclic parent chain", () => {
    const c = validCapture();
    c.documents[0]!.domLayoutNodes[0]!.parentSourceId = "d2"; // d1<->d2 cycle
    expect(codes(c)).toContain("parent_cycle");
  });

  it("rejects an unresolved parent", () => {
    const c = validCapture();
    c.documents[0]!.domLayoutNodes[1]!.parentSourceId = "ghost";
    expect(codes(c)).toContain("missing_parent");
  });

  it("rejects a non-positive viewport", () => {
    expect(
      codes(validCapture({ viewport: { widthCssPx: 0, heightCssPx: 800, deviceScaleFactor: 1, scrollXCssPx: 0, scrollYCssPx: 0 } })),
    ).toContain("invalid_viewport");
  });

  it("rejects malformed redaction metadata", () => {
    const c = validCapture();
    // @ts-expect-error intentionally malformed
    c.redaction = { applied: false, redactedSourceIds: [] };
    expect(codes(c)).toContain("invalid_redaction_metadata");
  });

  it("rejects a tenant-leaking / credential artifact ref", () => {
    const c = validCapture({
      screenshotEvidence: [
        { artifactRef: "https://user:pass@host/x", frameId: "root", widthImagePx: 1000, heightImagePx: 800, deviceScaleFactor: 1 },
      ],
    });
    expect(codes(c)).toContain("invalid_artifact_ref");
  });

  it("accepts an opaque scheme artifact ref", () => {
    const c = validCapture({
      screenshotEvidence: [
        { artifactRef: "uiart:sha256/abc123", frameId: "root", widthImagePx: 1000, heightImagePx: 800, deviceScaleFactor: 1 },
      ],
    });
    expect(validateCapture(c).ok).toBe(true);
  });

  it("rejects derived observations missing provider/version", () => {
    const c = validCapture({
      derivedObservations: [
        {
          kind: "vision_parser",
          provider: "",
          providerVersion: "",
          sourceImageRef: "uiart:img/1",
          elements: [{ sourceId: "v1", rectImagePx: { x: 0, y: 0, width: 10, height: 10 }, confidence: 0.9 }],
        },
      ],
    });
    expect(codes(c)).toContain("derived_missing_provenance");
  });

  it("rejects derived confidence outside [0,1]", () => {
    const c = validCapture({
      derivedObservations: [
        {
          kind: "ocr",
          provider: "tesseract",
          providerVersion: "5",
          sourceImageRef: "uiart:img/1",
          runs: [{ sourceId: "o1", rectImagePx: { x: 0, y: 0, width: 10, height: 10 }, text: "x", confidence: 1.5 }],
        },
      ],
    });
    expect(codes(c)).toContain("derived_missing_provenance");
  });

  it("rejects an unsupported DNA projection major", () => {
    const r = validateCapture(validCapture(), {
      projectionSchemaVersion: "2.0.0",
      dnaVersion: "dna_1",
      dnaContentDigest: "sha256:x",
      state: "approved",
      tokens: {},
      semanticRoles: [],
      componentFamilies: [],
      distributions: [],
      rules: [],
      exceptions: [],
      contexts: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.code)).toContain("unsupported_dna_major");
  });
});
