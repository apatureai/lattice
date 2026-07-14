import { describe, it, expect } from "vitest";
import {
  assertShadowNeverPublishes,
  assertSnapshotLocalRef,
  compareShadow,
  CONSUMER_CONTRACT_VERSION,
  CONSUMER_VIEW_CONTRACT,
  consumerContractFor,
  isElementRef,
  mayRequestView,
  resolveDelta,
  resolveSnapshotLocalRef,
  ShadowPublishError,
  UIGraphError,
  type ShadowRun,
} from "../src/index.js";

const DIGEST_A = "sha256:" + "ab".repeat(4) + "0".repeat(56);
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

describe("honest-reference seam — snapshot-local refs (#26, TRD §6/§16)", () => {
  it("recognizes a well-formed elementRef and rejects non-refs (never a selector)", () => {
    expect(isElementRef(REF_A)).toBe(true);
    expect(isElementRef("#my-button")).toBe(false);
    expect(isElementRef("button.primary")).toBe(false);
  });

  it("a ref local to the current snapshot resolves; a foreign ref is stale_or_foreign_ref + requery recovery", () => {
    expect(resolveSnapshotLocalRef(REF_A, DIGEST_A)).toEqual({ ok: true, elementRef: REF_A });
    expect(resolveSnapshotLocalRef(REF_B, DIGEST_A)).toEqual({ ok: false, reason: "stale_or_foreign_ref", recovery: "requery_lineage_match" });
  });

  it("assertSnapshotLocalRef throws a typed UIGraphError on a foreign ref", () => {
    expect(() => assertSnapshotLocalRef(REF_A, DIGEST_A)).not.toThrow();
    try {
      assertSnapshotLocalRef(REF_B, DIGEST_A);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UIGraphError);
      expect((e as UIGraphError).code).toBe("stale_or_foreign_ref");
    }
  });
});

describe("delta-corruption recovery (#26, TRD §16)", () => {
  it("a valid delta resolves; a base mismatch or corrupt delta falls back to a full checkpoint", () => {
    expect(resolveDelta({ valid: true, baseMatches: true })).toEqual({ ok: true });
    expect(resolveDelta({ valid: true, baseMatches: false })).toEqual({ ok: false, reason: "delta_base_mismatch", recovery: "full_checkpoint_fallback" });
    expect(resolveDelta({ valid: false, baseMatches: true })).toEqual({ ok: false, reason: "invalid_delta", recovery: "full_checkpoint_fallback" });
  });
});
