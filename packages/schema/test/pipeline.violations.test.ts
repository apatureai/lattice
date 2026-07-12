import { describe, expect, it } from "vitest";
import { projectDna, renderViolationsView, VIEW_POLICY_VERSION } from "@apature/ui-graph";
import type { AnyUIDNAReadProfile, UIDNAToken, UIGraphNode, UIGraphUseMode } from "@apature/ui-graph";

const TOKENS: Record<string, UIDNAToken> = {
  "--color-brand": { value: "#0a0a0a", category: "color", confidence: 1 },
  "--spacing-gap": { value: "8px", category: "spacing", confidence: 1 },
};

function profile(over: Partial<AnyUIDNAReadProfile> = {}): AnyUIDNAReadProfile {
  return {
    projectionSchemaVersion: "1.0.0",
    dnaVersion: "acme@7",
    dnaContentDigest: "sha256:abc",
    state: "approved",
    tokens: TOKENS,
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

/** Project DNA, then render violations — the real end-to-end flow. */
function violationsFor(nodes: UIGraphNode[], input: Parameters<typeof projectDna>[1]) {
  const res = projectDna(nodes, input);
  if (!res.ok) throw new Error("projection failed");
  return renderViolationsView(res.nodes, res.projection);
}

describe("renderViolationsView (#12, PRD §6.4)", () => {
  it("separates authoritative drift from advisory, omits conformant, deterministically", () => {
    const nodes = [
      node("el_bad", { color: "#123456", spacing: { gap: 13 } }), // both drift
      node("el_ok", { color: "#0a0a0a" }), // conformant (exact) — not a violation
    ];
    const a = violationsFor(nodes, { dna: profile(), useMode: prod, route: "/p" });
    const b = violationsFor(nodes, { dna: profile(), useMode: prod, route: "/p" });
    expect(a.text).toBe(b.text); // byte-identical
    expect(a.meta.view).toBe("violations");
    expect(a.meta.policyVersion).toBe(VIEW_POLICY_VERSION);

    const parsed = JSON.parse(a.text) as { authoritativeContext: boolean; authoritative: unknown[]; advisory: unknown[] };
    expect(parsed.authoritativeContext).toBe(true);
    expect(parsed.authoritative).toHaveLength(2); // color + spacing drift on el_bad
    expect(parsed.advisory).toHaveLength(0);
    expect(a.text).not.toContain("el_ok"); // conformant element never appears
  });

  it("ranks by severity: a larger scale deviation ranks above a smaller one", () => {
    const nodes = [
      node("el_small", { spacing: { gap: 11 } }), // delta 3 vs 8
      node("el_big", { spacing: { gap: 40 } }), // delta 32 vs 8 (far worse)
    ];
    const view = violationsFor(nodes, { dna: profile(), useMode: prod, route: "/p" });
    const parsed = JSON.parse(view.text) as { authoritative: { ref: string; severity: number }[] };
    expect(parsed.authoritative[0]!.ref).toBe("el_big");
    expect(parsed.authoritative[0]!.severity).toBeGreaterThan(parsed.authoritative[1]!.severity);
  });

  it("a shadow (experimental) build classifies drift as advisory, not authoritative", () => {
    const experimental = profile({ state: "draft", useMode: "shadow" } as Partial<AnyUIDNAReadProfile>);
    const view = violationsFor([node("el", { color: "#123456" })], { dna: experimental, useMode: "shadow", route: "/p" });
    const parsed = JSON.parse(view.text) as { authoritativeContext: boolean; authoritative: unknown[]; advisory: unknown[] };
    expect(parsed.authoritativeContext).toBe(false);
    expect(parsed.authoritative).toHaveLength(0);
    expect(parsed.advisory).toHaveLength(1);
  });

  it("surfaces exception-suppressed drift separately, never as a violation", () => {
    const exceptions = [{ route: "/promo", category: "token" as const, reason: "seasonal" }];
    const view = violationsFor([node("el", { color: "#123456" })], { dna: profile(), useMode: prod, route: "/promo", exceptions });
    const parsed = JSON.parse(view.text) as { authoritative: unknown[]; advisory: unknown[]; suppressed: { ref: string }[] };
    expect(parsed.authoritative).toHaveLength(0);
    expect(parsed.advisory).toHaveLength(0);
    expect(parsed.suppressed).toEqual([{ ref: "el", category: "token", observed: "#123456" }]);
  });

  it("each finding carries observed/canonical/delta/ref + an evidence requirement", () => {
    const view = violationsFor([node("el", { spacing: { gap: 40 } })], { dna: profile(), useMode: prod, route: "/p" });
    const parsed = JSON.parse(view.text) as { authoritative: Record<string, unknown>[] };
    const entry = parsed.authoritative[0]!;
    expect(entry).toMatchObject({ ref: "el", category: "scale", observed: 40, canonical: "8px", delta: 32 });
    expect(String(entry.evidenceRequirement)).toContain("off-scale");
  });

  it("no DNA projected ⇒ a fail-closed empty view (no drift without an authority)", () => {
    const res = projectDna([node("el", { color: "#123456" })], { useMode: prod, route: "/p" });
    if (!res.ok) throw new Error("unexpected");
    const view = renderViolationsView(res.nodes, res.projection);
    expect(view.text).toBe("");
    expect(view.meta.emptyReason).toMatch(/no UI-DNA projected/);
  });

  it("budgets across both groups and reports truncation, deterministically", () => {
    const nodes = [
      node("a", { spacing: { gap: 40 } }),
      node("b", { spacing: { gap: 30 } }),
      node("c", { spacing: { gap: 20 } }),
    ];
    const capped = renderViolationsForBudget(nodes, 2);
    expect(capped.meta.truncated).toBe(true);
    expect(capped.meta.omitted.nodes).toBe(1);
    const again = renderViolationsForBudget(nodes, 2);
    expect(again.text).toBe(capped.text);
  });
});

function renderViolationsForBudget(nodes: UIGraphNode[], maxNodes: number) {
  const res = projectDna(nodes, { dna: profile(), useMode: "production", route: "/p" });
  if (!res.ok) throw new Error("projection failed");
  return renderViolationsView(res.nodes, res.projection, { budget: { maxNodes } });
}
