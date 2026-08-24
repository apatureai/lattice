import { describe, expect, it } from "vitest";
import { projectDna, type DnaExceptionRule } from "@apatureai/lattice";
import type { AnyUIDNAReadProfile, UIDNAToken, UIGraphNode, UIGraphUseMode } from "@apatureai/lattice";

function token(value: string | number, category: string, confidence = 1): UIDNAToken {
  return { value, category, confidence };
}

const APPROVED_TOKENS: Record<string, UIDNAToken> = {
  "--color-brand": token("#0a0a0a", "color"),
  "--color-surface": token("#ffffff", "color"),
  "--spacing-gap": token("8px", "spacing"),
  "--spacing-lg": token("16px", "spacing"),
  "--radius-md": token("8px", "radii"),
};

function profile(over: Partial<AnyUIDNAReadProfile> = {}): AnyUIDNAReadProfile {
  return {
    projectionSchemaVersion: "1.0.0",
    dnaVersion: "acme@7",
    dnaContentDigest: "sha256:abc",
    state: "approved",
    tokens: APPROVED_TOKENS,
    semanticRoles: [],
    componentFamilies: [],
    distributions: [],
    rules: [],
    exceptions: [],
    contexts: [],
    ...over,
  } as AnyUIDNAReadProfile;
}

function node(elementRef: string, style: UIGraphNode["style"]): UIGraphNode {
  return {
    nodeId: `n_${elementRef}`,
    elementRef,
    kind: "control",
    regionIds: [],
    semantics: { states: {} },
    geometry: { frameId: "root", clipped: false },
    style,
    affordances: [],
    dnaMatches: [],
    locatorHints: [],
    evidence: [],
    sensitivity: ["public"],
    confidence: 0.9,
    flags: [],
  };
}

const prod: UIGraphUseMode = "production";

function only(nodes: UIGraphNode[]) {
  return nodes[0]!.dnaMatches;
}

describe("projectDna — token/scale matcher (#11, TRD §8.7)", () => {
  it("exact: an on-palette color and on-scale spacing match exactly and may be authoritative", () => {
    const res = projectDna([node("el", { color: "#0a0a0a", spacing: { gap: 8 } })], { dna: profile(), useMode: prod, route: "/p" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const matches = only(res.nodes);
    const color = matches.find((m) => m.category === "token")!;
    expect(color.status).toBe("exact");
    expect(color.method).toBe("exact_value");
    expect(color.canonical).toBe("#0a0a0a");
    expect(color.dnaRef).toBe("--color-brand");
    expect(color.authoritative).toBe(true); // approved + production
    const spacing = matches.find((m) => m.category === "scale")!;
    expect(spacing.dnaRef).toBe("--spacing-gap");
    expect(spacing.status).toBe("exact");
    expect(res.projection?.authoritativeMatchCount).toBe(2);
    expect(res.projection?.driftCount).toBe(0);
  });

  it("tolerance: a spacing 0.4px off the scale is within_tolerance with a delta", () => {
    const res = projectDna([node("el", { spacing: { gap: 8.4 } })], { dna: profile(), useMode: prod, route: "/p" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const m = only(res.nodes)[0]!;
    expect(m.status).toBe("within_tolerance");
    expect(m.delta).toBeCloseTo(0.4, 6);
    expect(m.authoritative).toBe(true);
  });

  it("drift: an off-palette color and a far-off-scale spacing are drift (a finding, never authoritative)", () => {
    const res = projectDna([node("el", { color: "#123456", spacing: { gap: 13 } })], { dna: profile(), useMode: prod, route: "/p" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const matches = only(res.nodes);
    expect(matches.every((m) => m.status === "drift")).toBe(true);
    expect(matches.every((m) => m.authoritative === false)).toBe(true); // drift is a finding, not a canonical assignment
    expect(res.projection?.driftCount).toBe(2);
    // The scale drift still reports the nearest canonical + delta.
    const spacing = matches.find((m) => m.category === "scale")!;
    expect(spacing.canonical).toBe("16px");
    expect(spacing.dnaRef).toBe("--spacing-lg");
    expect(spacing.delta).toBeCloseTo(3, 6);
  });

  it("exception: an approved route exception turns drift into excepted", () => {
    const exceptions: DnaExceptionRule[] = [{ route: "/promo", category: "token", reason: "seasonal banner" }];
    const res = projectDna([node("el", { color: "#123456" })], { dna: profile(), useMode: prod, route: "/promo", exceptions });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const m = only(res.nodes)[0]!;
    expect(m.status).toBe("excepted");
    expect(m.method).toBe("rule_evaluation");
    // A different route does NOT get the exception.
    const other = projectDna([node("el", { color: "#123456" })], { dna: profile(), useMode: prod, route: "/other", exceptions });
    expect(other.ok && only(other.nodes)[0]!.status).toBe("drift");
  });

  it("ambiguous / experimental: a shadow build forces every match non-authoritative", () => {
    const experimental = profile({ state: "draft", useMode: "shadow" } as Partial<AnyUIDNAReadProfile>);
    const res = projectDna([node("el", { color: "#0a0a0a" })], { dna: experimental, useMode: "shadow", route: "/p" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const m = only(res.nodes)[0]!;
    expect(m.status).toBe("exact"); // still an exact value match
    expect(m.authoritative).toBe(false); // but never authoritative outside approved+production
  });

  it("unapproved in production is rejected (fail-closed)", () => {
    const draft = profile({ state: "draft", useMode: "shadow" } as Partial<AnyUIDNAReadProfile>);
    const res = projectDna([node("el", { color: "#0a0a0a" })], { dna: draft, useMode: prod, route: "/p" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues.some((i) => i.code === "non_approved_dna_in_production")).toBe(true);
  });

  it("missing DNA is a neutral graph: no matches, no drift, no projection", () => {
    const res = projectDna([node("el", { color: "#123456" })], { useMode: prod, route: "/p" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(only(res.nodes)).toEqual([]);
    expect(res.projection).toBeUndefined();
  });

  it("abstains on unparseable observed values and on categories with no approved tokens", () => {
    const res = projectDna([node("el", { color: "not-a-color", fontSizeCssPx: 14 })], { dna: profile(), useMode: prod, route: "/p" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // unparseable color → abstain; typography has no approved tokens → abstain. No matches emitted.
    expect(only(res.nodes)).toEqual([]);
  });

  it("is deterministic and never mutates UI DNA (pure over inputs)", () => {
    const nodes = [node("el", { color: "#0a0a0a" })];
    const dna = profile();
    const a = projectDna(nodes, { dna, useMode: prod, route: "/p" });
    const b = projectDna(nodes, { dna, useMode: prod, route: "/p" });
    expect(a).toEqual(b);
    expect(nodes[0]!.dnaMatches).toEqual([]); // input node untouched
    expect(dna.tokens).toBe(APPROVED_TOKENS); // DNA never mutated
  });
});
