/**
 * Frozen representation fixture manifest tests (issue #19).
 *
 * Fixtures-only: the manifest is pure MOCK metadata over the golden capture
 * read-profiles (issue #3). No model, browser, or network is touched. These
 * tests are the acceptance check for #19: the manifest is frozen +
 * content-addressed, references the required metadata, and ug-delta carries
 * canonical target hashes.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  REPRESENTATION_MANIFEST,
  verifyManifest,
  freezeManifest,
  fixtureContentHash,
  FIXTURE_SET_IDS,
  type FixtureEntry,
} from "@apature/ui-graph";

const allFixtures = (): FixtureEntry[] =>
  REPRESENTATION_MANIFEST.sets.flatMap((s) => s.fixtures);

const fixturePath = (rel: string) =>
  fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url));

describe("representation manifest is frozen + content-addressed (#19)", () => {
  it("verifies clean: every fixture + the manifest hash recompute", () => {
    const v = verifyManifest(REPRESENTATION_MANIFEST);
    expect(v.ok, v.ok ? "" : JSON.stringify(v.errors)).toBe(true);
  });

  it("pins the frozen manifest content hash", () => {
    // Freeze the manifest id so any drift in a fixture is a failing test, not a
    // silent change (mirrors the golden-fixture freeze in adapter.test.ts).
    expect(REPRESENTATION_MANIFEST.manifestContentHash).toBe(
      "sha256:61c30bf0126deae2cf54fd4d10d781dce4e56df46072fbc679b5bf70999b6c9b" // re-pinned July 15, 2026: ug-delta placeholder hashes replaced with real canonical chain hashes (#14),
    );
  });

  it("covers all six PRD §8.1 internal frozen sets exactly once", () => {
    const ids = REPRESENTATION_MANIFEST.sets.map((s) => s.setId);
    expect(ids).toEqual([...FIXTURE_SET_IDS]);
    expect(new Set(ids).size).toBe(FIXTURE_SET_IDS.length);
  });

  it("re-freezing identical input yields an identical manifest (deterministic)", () => {
    const again = freezeManifest(
      REPRESENTATION_MANIFEST.sets.map((s) => ({
        setId: s.setId,
        description: s.description,
        // Strip the assigned contentHash so freeze re-derives it.
        fixtures: s.fixtures.map(({ contentHash: _drop, ...body }) => body),
      })),
    );
    expect(again.manifestContentHash).toBe(REPRESENTATION_MANIFEST.manifestContentHash);
  });

  it("detects a mutated fixture (freeze is not a no-op)", () => {
    const tampered = structuredClone(REPRESENTATION_MANIFEST);
    (tampered.sets[0]!.fixtures[0]! as { title: string }).title = "MUTATED";
    const v = verifyManifest(tampered);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.includes("content hash drifted"))).toBe(true);
  });
});

describe("every fixture records the required PRD §8.1 metadata", () => {
  it("stamps capture/browser/viewport/builder/dna/redaction on every fixture", () => {
    for (const f of allFixtures()) {
      const p = f.provenance;
      expect(p.captureVersion, f.fixtureId).toBeTruthy();
      expect(p.browserVersion, f.fixtureId).toBeTruthy();
      expect(p.viewport.widthCssPx, f.fixtureId).toBeGreaterThan(0);
      expect(p.viewport.heightCssPx, f.fixtureId).toBeGreaterThan(0);
      expect(p.graphBuilderVersion, f.fixtureId).toBeTruthy();
      expect(p.uiDnaVersion, f.fixtureId).toBeTruthy();
      expect(p.redactionPolicyVersion, f.fixtureId).toBeTruthy();
    }
  });

  it("records license + consent status for EVERY fixture", () => {
    for (const f of allFixtures()) {
      expect(f.provenance.license.spdx, f.fixtureId).toBeTruthy();
      expect(f.provenance.license.consent, f.fixtureId).toBeTruthy();
    }
  });

  it("a fixture missing a stamp fails verification", () => {
    const bad = structuredClone(REPRESENTATION_MANIFEST);
    const entry = bad.sets[0]!.fixtures[0]!;
    (entry.provenance as { graphBuilderVersion: string }).graphBuilderVersion = "";
    // Re-seal the tampered entry so the stamp check is what fails (not only the
    // downstream content-hash drift).
    const { contentHash: _c, ...body } = entry;
    (entry as { contentHash: string }).contentHash = fixtureContentHash(body);
    const v = verifyManifest(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.includes("graphBuilderVersion"))).toBe(true);
  });

  it("every captureRef resolves to a frozen golden fixture (issue #3)", () => {
    const captures = new Set(readdirSync(fixturePath("capture")));
    for (const f of allFixtures()) {
      const rel = f.captureRef.replace(/^capture\//, "");
      expect(captures.has(rel), `${f.fixtureId} -> ${f.captureRef}`).toBe(true);
      // The referenced bytes must be readable (the harness resolves them).
      expect(readFileSync(fixturePath(f.captureRef), "utf8").length).toBeGreaterThan(0);
    }
  });
});

describe("ug-delta fixtures carry canonical target hashes", () => {
  const deltaSet = () => REPRESENTATION_MANIFEST.sets.find((s) => s.setId === "ug-delta")!;

  it("every ug-delta fixture has a non-empty mutation sequence", () => {
    for (const f of deltaSet().fixtures) {
      expect(f.deltaSequence, f.fixtureId).toBeDefined();
      expect(f.deltaSequence!.length, f.fixtureId).toBeGreaterThan(0);
    }
  });

  it("every step carries a canonical sha256 target hash", () => {
    for (const f of deltaSet().fixtures) {
      for (const step of f.deltaSequence!) {
        expect(step.canonicalTargetHash, `${f.fixtureId}/${step.label}`).toMatch(
          /^sha256:[a-f0-9]{64}$/,
        );
      }
    }
  });

  it("a ug-delta fixture without target hashes fails verification", () => {
    const bad = structuredClone(REPRESENTATION_MANIFEST);
    const set = bad.sets.find((s) => s.setId === "ug-delta")!;
    const entry = set.fixtures[0]!;
    (entry.deltaSequence![0] as { canonicalTargetHash: string }).canonicalTargetHash = "not-a-hash";
    const { contentHash: _c, ...body } = entry;
    (entry as { contentHash: string }).contentHash = fixtureContentHash(body);
    const v = verifyManifest(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.includes("canonical target hash"))).toBe(true);
  });
});

describe("per-cohort coverage (anti-masking, TRD §15.3)", () => {
  it("exercises dense, long-page, non-DOM, responsive, and injection cohorts", () => {
    const cohorts = new Set(allFixtures().flatMap((f) => f.cohorts));
    for (const required of ["dense", "long_page", "non_dom", "responsive", "injection"] as const) {
      expect(cohorts.has(required), `cohort ${required} uncovered`).toBe(true);
    }
  });
});
