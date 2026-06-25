import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  validateCaptureBundle,
  validateDnaProfile,
  dnaMatchesMayBeAuthoritative,
  type CaptureBundleReadProfile,
  type AnyUIDNAReadProfile,
} from "@apature/ui-graph";

const fixturePath = (rel: string) =>
  fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url));

const loadRaw = (rel: string) => readFileSync(fixturePath(rel), "utf8");
const load = <T>(rel: string): T => JSON.parse(loadRaw(rel)) as T;

const manifest = load<{ files: Record<string, string> }>("MANIFEST.json");

const minimalCapture = () =>
  load<CaptureBundleReadProfile>("capture/minimal.json");
const multiFrameCapture = () =>
  load<CaptureBundleReadProfile>("capture/multi-frame.json");
const derivedCapture = () =>
  load<CaptureBundleReadProfile>("capture/with-derived.json");
const approvedDna = () => load<AnyUIDNAReadProfile>("dna/approved.json");
const draftDna = () => load<AnyUIDNAReadProfile>("dna/experimental-draft.json");

describe("golden fixtures are frozen (TRD M0)", () => {
  it("matches the recorded SHA-256 digests", () => {
    for (const [rel, digest] of Object.entries(manifest.files)) {
      const actual = createHash("sha256").update(loadRaw(rel)).digest("hex");
      expect(actual, `fixture ${rel} drifted`).toBe(digest);
    }
  });
});

describe("capture read profile (TRD §4.1)", () => {
  it("accepts minimal, multi-frame, and derived-observation fixtures", () => {
    for (const cap of [minimalCapture(), multiFrameCapture(), derivedCapture()]) {
      const r = validateCaptureBundle(cap);
      expect(r.ok, r.ok ? "" : JSON.stringify(r.issues)).toBe(true);
    }
  });

  it("records the source schema versions consumed", () => {
    const r = validateCaptureBundle(minimalCapture());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sourceVersions.captureSchemaVersion).toBe("1.0.0");
      expect(r.sourceVersions.captureVersion).toBe("playwright-capture@3");
    }
  });

  it("rejects an unsupported source-schema major (TRD §8.1)", () => {
    const cap = minimalCapture();
    cap.schemaVersion = "2.0.0";
    const r = validateCaptureBundle(cap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === "unsupported_source_major")).toBe(true);
  });

  it("rejects a derived observation missing provider/version (TRD §8.1, §16)", () => {
    const cap = derivedCapture();
    (cap.derivedObservations![0] as { provider: string }).provider = "";
    const r = validateCaptureBundle(cap);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(
        r.issues.some((i) => i.code === "derived_observation_missing_provenance"),
      ).toBe(true);
  });

  it("rejects a vision_parser element missing confidence", () => {
    const cap = derivedCapture();
    const obs = cap.derivedObservations![0];
    if (obs.kind === "vision_parser") {
      delete (obs.elements[0] as { confidence?: number }).confidence;
    }
    const r = validateCaptureBundle(cap);
    expect(r.ok).toBe(false);
  });
});

describe("UI-DNA read profile (TRD §4.3, §16)", () => {
  it("accepts approved DNA in a production build, authoritative-eligible", () => {
    const r = validateDnaProfile(approvedDna(), "production");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sourceVersions.dnaUseMode).toBe("production");
    expect(dnaMatchesMayBeAuthoritative(approvedDna(), "production")).toBe(true);
  });

  it("rejects non-approved DNA in a production build (TRD §16)", () => {
    const r = validateDnaProfile(draftDna(), "production");
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues.some((i) => i.code === "non_approved_dna_in_production")).toBe(true);
  });

  it("accepts experimental draft DNA in shadow, forced non-authoritative", () => {
    const r = validateDnaProfile(draftDna(), "shadow");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sourceVersions.dnaUseMode).toBe("shadow");
    // Experimental DNA can never be authoritative, regardless of build mode.
    expect(dnaMatchesMayBeAuthoritative(draftDna(), "shadow")).toBe(false);
    expect(dnaMatchesMayBeAuthoritative(draftDna(), "production")).toBe(false);
  });

  it("rejects experimental DNA that declares no offline_eval/shadow useMode", () => {
    const bad = draftDna() as AnyUIDNAReadProfile & { useMode?: string };
    delete bad.useMode;
    const r = validateDnaProfile(bad, "shadow");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.code === "invalid_use_mode")).toBe(true);
  });

  it("approved DNA used in shadow is not authoritative (only production+approved is)", () => {
    expect(dnaMatchesMayBeAuthoritative(approvedDna(), "shadow")).toBe(false);
    expect(dnaMatchesMayBeAuthoritative(undefined, "production")).toBe(false);
  });
});
