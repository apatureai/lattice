import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  assertRepresentationOnly,
  buildUiGraphCapabilityDescriptor,
  computeCapabilityDescriptorDigest,
  EXCLUDED_CAPABILITIES,
  NonRepresentationCapabilityError,
  serializeCapabilityDescriptor,
  SCHEMA_VERSION,
  SUPPORTED_CAPTURE_MAJORS,
  SUPPORTED_DNA_PROJECTION_MAJORS,
  UI_GRAPH_CAPABILITY_DESCRIPTOR_VERSION,
  validateCapabilityDescriptor,
  type UiGraphCapabilityDescriptor,
} from "../src/index.js";

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/golden-capability-descriptor.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

describe("UI Graph capability descriptor (#25, core #105)", () => {
  it("matches the pinned descriptor shape (golden; additive only)", () => {
    expect(buildUiGraphCapabilityDescriptor()).toEqual(golden);
  });

  it("enumerates the four operations and six view kinds (TRD §1/§10)", () => {
    const d = buildUiGraphCapabilityDescriptor();
    expect(d.descriptorVersion).toBe(UI_GRAPH_CAPABILITY_DESCRIPTOR_VERSION);
    expect(d.operations).toEqual(["buildUiGraph", "queryUiGraph", "diffUiGraphs", "applyUiGraphDelta"]);
    expect(d.viewKinds).toEqual(["summary", "violations", "focus", "actionMap", "patchContext", "diff"]);
  });

  it("derives produced/consumed majors from the REAL contract constants (can't over-claim)", () => {
    const d = buildUiGraphCapabilityDescriptor();
    const major = SCHEMA_VERSION.split(".")[0];
    expect(d.produced.snapshot.supported).toEqual([major]);
    expect(d.produced.view.supported).toEqual([major]);
    expect(d.produced.delta.supported).toEqual([major]);
    expect(d.consumed.captureBundle.supported).toEqual([...SUPPORTED_CAPTURE_MAJORS]);
    expect(d.consumed.dnaProjection.supported).toEqual([...SUPPORTED_DNA_PROJECTION_MAJORS]);
  });
});

describe("perception-only boundary (TRD §10.2, #16; ARCHITECTURE §16)", () => {
  it("advertises representation only and excludes every action/model/browser/capture/delivery capability", () => {
    const d = buildUiGraphCapabilityDescriptor();
    expect(d.capabilityClass).toBe("representation");
    expect(d.exposure).toBe("library_in_judgment_engine");
    for (const cap of EXCLUDED_CAPABILITIES) expect(d.excludes).toContain(cap);
    expect(d.excludes).toContain("action_execution");
  });

  it("keeps actionMap a perception view, never an action affordance", () => {
    const d = buildUiGraphCapabilityDescriptor();
    expect(d.viewKinds).toContain("actionMap");
    expect(d.actionMapIsPerceptionOnly).toBe(true);
  });

  it("validates clean and assertRepresentationOnly passes", () => {
    expect(validateCapabilityDescriptor(buildUiGraphCapabilityDescriptor())).toEqual({ valid: true, errors: [] });
    expect(() => assertRepresentationOnly(buildUiGraphCapabilityDescriptor())).not.toThrow();
  });

  it("fails closed if the class flips to action or an exclusion is dropped", () => {
    const base = buildUiGraphCapabilityDescriptor();
    const asAction = { ...base, capabilityClass: "action" as never };
    expect(validateCapabilityDescriptor(asAction).valid).toBe(false);
    expect(() => assertRepresentationOnly(asAction)).toThrow(NonRepresentationCapabilityError);

    const droppedExclude: UiGraphCapabilityDescriptor = { ...base, excludes: base.excludes.filter((c) => c !== "action_execution") };
    expect(() => assertRepresentationOnly(droppedExclude)).toThrow(/action_execution/);
  });
});

describe("descriptor is foldable + pinnable (core #105 §2/§3)", () => {
  it("canonical serialization is deterministic and digest is sha256-prefixed", () => {
    const d = buildUiGraphCapabilityDescriptor();
    expect(serializeCapabilityDescriptor(d)).toBe(serializeCapabilityDescriptor(buildUiGraphCapabilityDescriptor()));
    expect(computeCapabilityDescriptorDigest(d)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("provides the version-negotiation policy a caller needs (#18)", () => {
    const d = buildUiGraphCapabilityDescriptor();
    expect(d.negotiation.extensionsNamespacePrefix).toBe("x-uigraph-");
    expect(d.negotiation.unknownEnumPolicy).toBe("reject");
    // one-prior arrays are present (empty now: only major 1 exists) — the field the caller negotiates on.
    expect(d.produced.snapshot.onePrior).toEqual([]);
  });
});
