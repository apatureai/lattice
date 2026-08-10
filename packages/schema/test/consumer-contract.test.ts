import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  assertElementRefInSnapshot,
  assertShadowNeverPublishes,
  compareShadow,
  CONSUMER_CONTRACT_VERSION,
  CONSUMER_VIEW_CONTRACT,
  consumerContractFor,
  isElementRef,
  mayRequestView,
  resolveDelta,
  resolveElementRefInSnapshot,
  sealSnapshot,
  ShadowPublishError,
  UIGraphError,
  type ShadowRun,
  type UIGraphSnapshot,
} from "../src/index.js";

// ref-scope prefixes: A → "abababab", B → "cdcdcdcd"
const REF_A = "ug:abababab:3";
const REF_B = "ug:cdcdcdcd:1";

describe("consumer view-consumption contract (#26, PRD §4)", () => {
  it("each named consumer has a documented view set + must-not-depend-on list", () => {
    expect(CONSUMER_CONTRACT_VERSION).toBe("ui-graph-consumer/1");
    expect(consumerContractFor("gate").requestsViewKinds).toEqual(["violations", "patchContext", "focus"]);
    expect(consumerContractFor("pointer").requestsViewKinds).toEqual(["focus", "diff"]);
    expect(consumerContractFor("interactive_review").requestsViewKinds).toEqual(["actionMap"]);
    for (const c of Object.values(CONSUMER_VIEW_CONTRACT)) {
      expect(c.mustNotDependOn).toContain("another_tenants_graph");
      expect(c.mustNotDependOn).toContain("element_ref_as_selector");
    }
  });

  it("interactive_review's actionMap is read-only perception, never an action affordance", () => {
    const ir = consumerContractFor("interactive_review");
    expect(ir.readOnlyPerception).toBe(true);
    expect(ir.mustNotDependOn).toContain("action_map_as_action_affordance");
  });

  it("mayRequestView enforces the per-surface view set", () => {
    expect(mayRequestView("gate", "violations")).toBe(true);
    expect(mayRequestView("gate", "actionMap")).toBe(false);
    expect(mayRequestView("interactive_review", "actionMap")).toBe(true);
  });
});

describe("R2 shadow-build contract (#26, PRD §9 R2)", () => {
  const run: ShadowRun = {
    captureId: "cap_1",
    usedForPublishedFinding: false,
    graphBackedPromptHash: "sha256:aaa",
    currentPromptHash: "sha256:bbb",
  };

  it("a shadow run never publishes and exposes a graph-vs-current comparison hook", () => {
    expect(assertShadowNeverPublishes(run)).toBe(run);
    expect(compareShadow(run)).toEqual({
      captureId: "cap_1",
      graphBackedPromptHash: "sha256:aaa",
      currentPromptHash: "sha256:bbb",
      differs: true,
    });
    expect(compareShadow({ ...run, currentPromptHash: "sha256:aaa" }).differs).toBe(false);
  });

  it("fails closed if a shadow run is mis-marked as used for a published finding", () => {
    expect(() => assertShadowNeverPublishes({ ...run, usedForPublishedFinding: true as unknown as false })).toThrow(ShadowPublishError);
  });
});

describe("honest-reference seam — exact snapshot membership (#56, TRD §6/§16)", () => {
  const sealed = JSON.parse(
    readFileSync(fileURLToPath(new URL("./examples/minimal-snapshot.json", import.meta.url)), "utf8"),
  ) as UIGraphSnapshot;
  const claimed = { snapshotId: sealed.snapshotId, contentHash: sealed.contentHash };
  const realRef = sealed.nodes[0]!.elementRef;
  const prefix = realRef.split(":")[1]!;

  it("recognizes a well-formed elementRef and rejects non-refs (never a selector)", () => {
    expect(isElementRef(REF_A)).toBe(true);
    expect(isElementRef("#my-button")).toBe(false);
    expect(isElementRef("button.primary")).toBe(false);
  });

  it("a real member ref of the verified snapshot resolves", () => {
    expect(resolveElementRefInSnapshot(sealed, claimed, realRef)).toEqual({ ok: true, elementRef: realRef });
  });

  it("the #56 repro: a fabricated ordinal under the CORRECT prefix is refused", () => {
    expect(resolveElementRefInSnapshot(sealed, claimed, `ug:${prefix}:999999`)).toMatchObject({
      ok: false,
      reason: "stale_or_foreign_ref",
      detail: "ref_not_in_snapshot",
    });
  });

  it("prefix is not authority: same ref prefix but a different full digest tuple is foreign", () => {
    const mutatedTail = { ...claimed, contentHash: claimed.contentHash.slice(0, -1) + (claimed.contentHash.endsWith("0") ? "1" : "0") };
    expect(resolveElementRefInSnapshot(sealed, mutatedTail, realRef)).toMatchObject({
      ok: false,
      detail: "wrong_snapshot_identity",
    });
    const wrongId = { ...claimed, snapshotId: `${claimed.snapshotId.slice(0, -1)}f` };
    expect(resolveElementRefInSnapshot(sealed, wrongId, realRef)).toMatchObject({
      ok: false,
      detail: "wrong_snapshot_identity",
    });
  });

  it("a copied foreign-prefix ref and malformed refs are refused with typed details", () => {
    expect(resolveElementRefInSnapshot(sealed, claimed, REF_B)).toMatchObject({ ok: false, detail: "ref_not_in_snapshot" });
    expect(resolveElementRefInSnapshot(sealed, claimed, "not-a-ref")).toMatchObject({ ok: false, detail: "malformed_ref" });
    expect(resolveElementRefInSnapshot(sealed, claimed, "ug:ZZZZZZZZ:0")).toMatchObject({ ok: false, detail: "malformed_ref" });
  });

  it("a tampered snapshot fails identity verification before any resolution", () => {
    const tampered = structuredClone(sealed);
    tampered.nodes[0]!.elementRef = `ug:${prefix}:7`;
    expect(resolveElementRefInSnapshot(tampered, claimed, realRef)).toMatchObject({
      ok: false,
      detail: "snapshot_identity_invalid",
    });
  });

  it("assertElementRefInSnapshot throws the typed UIGraphError fail-closed", () => {
    expect(() => assertElementRefInSnapshot(sealed, claimed, realRef)).not.toThrow();
    try {
      assertElementRefInSnapshot(sealed, claimed, `ug:${prefix}:999999`);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UIGraphError);
      expect((e as UIGraphError).code).toBe("stale_or_foreign_ref");
    }
  });

  it("property: random fabricated ordinals and mutated identity tuples yield ZERO false accepts", () => {
    let seed = 0xc0ffee;
    const rng = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const memberOrdinals = new Set(sealed.nodes.map((n) => Number(n.elementRef.split(":")[2])));
    for (let i = 0; i < 300; i += 1) {
      const ordinal = Math.floor(rng() * 2 ** 20);
      if (memberOrdinals.has(ordinal)) continue;
      expect(resolveElementRefInSnapshot(sealed, claimed, `ug:${prefix}:${ordinal}`).ok).toBe(false);
    }
    const hex = "0123456789abcdef";
    for (let i = 0; i < 200; i += 1) {
      const pos = 7 + Math.floor(rng() * (claimed.contentHash.length - 7));
      const original = claimed.contentHash[pos]!;
      const replacement = hex[Math.floor(rng() * 16)]!;
      if (replacement === original) continue;
      const mutated = claimed.contentHash.slice(0, pos) + replacement + claimed.contentHash.slice(pos + 1);
      expect(resolveElementRefInSnapshot(sealed, { ...claimed, contentHash: mutated }, realRef).ok).toBe(false);
    }
  });

  it("re-sealing an equivalent draft preserves identity and refs still resolve", () => {
    const { snapshotId: _i, contentHash: _h, nodes, ...semantic } = structuredClone(sealed);
    const draft = { ...semantic, nodes: nodes.map(({ elementRef: _r, ...node }) => node) };
    const resealed = sealSnapshot(draft as Parameters<typeof sealSnapshot>[0]);
    expect(resealed.snapshotId).toBe(sealed.snapshotId);
    expect(
      resolveElementRefInSnapshot(resealed, { snapshotId: resealed.snapshotId, contentHash: resealed.contentHash }, realRef).ok,
    ).toBe(true);
  });

  it("golden membership fixture replays byte-for-byte (the copy consumer adapters mirror)", () => {
    const golden = JSON.parse(
      readFileSync(fileURLToPath(new URL("./fixtures/element-ref-membership.golden.json", import.meta.url)), "utf8"),
    ) as {
      claimed: { snapshotId: string; contentHash: string };
      vectors: Array<{ name: string; elementRef: string; claimed?: { snapshotId: string; contentHash: string }; expect: { ok: boolean; detail?: string } }>;
    };
    expect(golden.claimed).toEqual(claimed);
    for (const vector of golden.vectors) {
      const result = resolveElementRefInSnapshot(sealed, vector.claimed ?? golden.claimed, vector.elementRef);
      expect(result.ok, vector.name).toBe(vector.expect.ok);
      if (!result.ok) expect(result.detail, vector.name).toBe(vector.expect.detail);
    }
  });

  it("the prefix-only resolver is gone from the package surface (capability guard)", async () => {
    const surface = await import("../src/index.js");
    expect("resolveSnapshotLocalRef" in surface).toBe(false);
    expect("assertSnapshotLocalRef" in surface).toBe(false);
  });
});

describe("delta-corruption recovery (#26, TRD §16)", () => {
  it("a valid delta resolves; a base mismatch or corrupt delta falls back to a full checkpoint", () => {
    expect(resolveDelta({ valid: true, baseMatches: true })).toEqual({ ok: true });
    expect(resolveDelta({ valid: true, baseMatches: false })).toEqual({ ok: false, reason: "delta_base_mismatch", recovery: "full_checkpoint_fallback" });
    expect(resolveDelta({ valid: false, baseMatches: true })).toEqual({ ok: false, reason: "invalid_delta", recovery: "full_checkpoint_fallback" });
  });
});
