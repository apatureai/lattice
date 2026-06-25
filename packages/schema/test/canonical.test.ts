import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  canonicalize,
  computeContentHash,
  deriveSnapshotId,
  makeElementRef,
  sealSnapshot,
  sha256,
  validateSnapshot,
  formatErrors,
  type UIGraphSnapshot,
} from "@apature/ui-graph";

const minimalSnapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./examples/minimal-snapshot.json", import.meta.url)),
    "utf8",
  ),
) as UIGraphSnapshot;

describe("RFC 8785 canonicalization", () => {
  it("sorts object keys by UTF-16 code unit", () => {
    expect(canonicalize({ b: 1, a: 2, A: 3 })).toBe('{"A":3,"a":2,"b":1}');
  });

  it("drops undefined properties (optional fields are omitted, not null)", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("serializes -0 as 0", () => {
    expect(canonicalize(-0)).toBe("0");
  });

  it("rejects NaN and Infinity", () => {
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize(Infinity)).toThrow();
  });

  it("is independent of input key order", () => {
    const a = canonicalize({ x: { p: 1, q: 2 }, y: [3, 2, 1] });
    const b = canonicalize({ y: [3, 2, 1], x: { q: 2, p: 1 } });
    expect(a).toBe(b);
  });

  it("escapes control characters and quotes", () => {
    expect(canonicalize("a\nb\"c\\d")).toBe('"a\\nb\\"c\\\\d"');
  });
});

describe("content hashing determinism (TRD §15.2, §19)", () => {
  it("produces an identical hash across repeated builds of identical semantic input", () => {
    const h1 = computeContentHash(minimalSnapshot);
    const h2 = computeContentHash(structuredClone(minimalSnapshot));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("excludes contentHash and snapshotId from the hash", () => {
    const a = structuredClone(minimalSnapshot);
    const b = structuredClone(minimalSnapshot);
    b.contentHash =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    b.snapshotId = "ugs_1_ffffffffffff";
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it("changes the hash when a semantic field changes", () => {
    const a = computeContentHash(minimalSnapshot);
    const mutated = structuredClone(minimalSnapshot);
    mutated.source.route = "/changed";
    expect(computeContentHash(mutated)).not.toBe(a);
  });
});

describe("content-addressed IDs (TRD §6)", () => {
  it("derives a schema-major-prefixed snapshotId matching the schema pattern", () => {
    const h = computeContentHash(minimalSnapshot);
    const id = deriveSnapshotId(minimalSnapshot, h);
    expect(id).toMatch(/^ugs_1_[a-f0-9]{12,64}$/);
  });

  it("makes snapshot-scoped element refs", () => {
    const h = computeContentHash(minimalSnapshot);
    expect(makeElementRef(h, 0)).toMatch(/^ug:[a-f0-9]{8}:0$/);
  });

  it("sha256 returns the prefixed lowercase hex digest", () => {
    expect(sha256("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("sealSnapshot", () => {
  it("assigns a stable content hash and snapshotId and revalidates against the schema", () => {
    const draft = structuredClone(minimalSnapshot);
    draft.contentHash =
      "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    draft.snapshotId = "ugs_1_111111111111";
    const sealed = sealSnapshot(draft);
    // Idempotent: re-sealing a sealed snapshot yields the same hash/id.
    const resealed = sealSnapshot(sealed);
    expect(resealed.contentHash).toBe(sealed.contentHash);
    expect(resealed.snapshotId).toBe(sealed.snapshotId);
    // The sealed snapshot still validates against the normative schema.
    const r = validateSnapshot(sealed);
    expect(r.valid, r.valid ? "" : formatErrors(r.errors)).toBe(true);
  });
});
