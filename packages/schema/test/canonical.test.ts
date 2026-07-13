import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  canonicalize,
  assertSnapshotIdentity,
  computeContentHash,
  computeRefScopeDigest,
  deriveSnapshotId,
  makeElementRef,
  sealSnapshot,
  sha256,
  validateSnapshot,
  formatErrors,
  type UIGraphSnapshot,
  type UIGraphSnapshotDraft,
} from "@apature/ui-graph";

const minimalSnapshot = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./examples/minimal-snapshot.json", import.meta.url)),
    "utf8",
  ),
) as UIGraphSnapshot;

function refFreeDraft(snapshot = minimalSnapshot): UIGraphSnapshotDraft {
  const {
    snapshotId: _snapshotId,
    contentHash: _contentHash,
    nodes,
    ...semantic
  } = structuredClone(snapshot);
  return {
    ...semantic,
    nodes: nodes.map(({ elementRef: _elementRef, ...node }) => node),
  };
}

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
    const scope = computeRefScopeDigest(refFreeDraft());
    expect(makeElementRef(scope, 0)).toMatch(/^ug:[a-f0-9]{8}:0$/);
  });

  it("sha256 returns the prefixed lowercase hex digest", () => {
    expect(sha256("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("sealSnapshot", () => {
  it("keeps the normative example identity-valid", () => {
    expect(() => assertSnapshotIdentity(minimalSnapshot)).not.toThrow();
    expect(sealSnapshot(minimalSnapshot)).toEqual(minimalSnapshot);
  });

  it("assigns refs, content hash, and snapshotId from a ref-free draft", () => {
    const draft = refFreeDraft();
    const sealed = sealSnapshot(draft);
    const resealed = sealSnapshot(sealed);
    expect(sealed.nodes[0]?.elementRef).toMatch(/^ug:[a-f0-9]{8}:0$/);
    expect(resealed.contentHash).toBe(sealed.contentHash);
    expect(resealed.snapshotId).toBe(sealed.snapshotId);
    expect(resealed).toEqual(sealed);
    expect(() => assertSnapshotIdentity(sealed)).not.toThrow();
    const r = validateSnapshot(sealed);
    expect(r.valid, r.valid ? "" : formatErrors(r.errors)).toBe(true);
  });

  it("is byte-stable when ref-free nodes arrive in a different order", () => {
    const first = refFreeDraft();
    first.nodes.push({ ...structuredClone(first.nodes[0]!), nodeId: "n_second" });
    const reordered = structuredClone(first);
    reordered.nodes.reverse();
    expect(canonicalize(sealSnapshot(reordered))).toBe(canonicalize(sealSnapshot(first)));
  });

  it("changes to semantic input produce a new self-consistent tuple", () => {
    const original = sealSnapshot(refFreeDraft());
    const changedDraft = refFreeDraft();
    changedDraft.source.route = "/changed";
    const changed = sealSnapshot(changedDraft);
    expect(changed.contentHash).not.toBe(original.contentHash);
    expect(changed.snapshotId).not.toBe(original.snapshotId);
    expect(changed.nodes[0]?.elementRef).not.toBe(original.nodes[0]?.elementRef);
    expect(() => assertSnapshotIdentity(changed)).not.toThrow();
  });

  it.each([
    ["copied foreign ref", (snapshot: UIGraphSnapshot) => { snapshot.nodes[0]!.elementRef = "ug:deadbeef:0"; }],
    ["duplicate ordinal", (snapshot: UIGraphSnapshot) => {
      snapshot.nodes.push({ ...structuredClone(snapshot.nodes[0]!), nodeId: "n_second" });
    }],
    ["stale content hash", (snapshot: UIGraphSnapshot) => { snapshot.source.route = "/mutated"; }],
    ["wrong snapshot id", (snapshot: UIGraphSnapshot) => { snapshot.snapshotId = "ugs_1_ffffffffffff"; }],
  ])("rejects %s", (_label, corrupt) => {
    const sealed = sealSnapshot(refFreeDraft());
    corrupt(sealed);
    expect(() => assertSnapshotIdentity(sealed)).toThrow();
    expect(() => sealSnapshot(sealed)).toThrow();
  });

  it("rejects caller-supplied placeholder identity instead of preserving it", () => {
    const stale = structuredClone(minimalSnapshot);
    stale.nodes[0]!.elementRef = "ug:aaaaaaaa:0";
    expect(() => sealSnapshot(stale)).toThrow(/inconsistent elementRef/);
  });
});
