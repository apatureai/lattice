import { describe, expect, it } from "vitest";
import {
  renderPatchContextView,
  VIEW_POLICY_VERSION,
  type PatchContextSource,
} from "@apature/ui-graph";
import type { LocatorHint, SensitivityLabel, UIDNAMatch, UIGraphNode } from "@apature/ui-graph";

const source: PatchContextSource = {
  route: "/pricing",
  viewport: { widthCssPx: 1280, heightCssPx: 800, deviceScaleFactor: 1, scrollXCssPx: 0, scrollYCssPx: 0 },
};

function node(overrides: Partial<UIGraphNode> & { elementRef: string }): UIGraphNode {
  return {
    nodeId: `n_${overrides.elementRef}`,
    kind: "control",
    regionIds: [],
    semantics: { states: {} },
    geometry: { frameId: "root", clipped: false, normalizedViewportRect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 } },
    style: {},
    affordances: [],
    dnaMatches: [],
    locatorHints: [],
    evidence: [],
    sensitivity: ["public"],
    confidence: 0.9,
    flags: [],
    ...overrides,
  };
}

function hint(over: Partial<LocatorHint> & { kind: LocatorHint["kind"]; value: string; scope: LocatorHint["scope"] }): LocatorHint {
  return { uniqueness: 0.9, stability: 0.9, confidence: 0.9, ...over };
}

const button = (): UIGraphNode =>
  node({
    elementRef: "el_cta",
    semantics: { role: "button", name: "Start free trial", states: {} },
    style: { color: "#0a0a0a", backgroundColor: "#ffffff", borderRadiusCssPx: [8], fontSizeCssPx: 14 },
    locatorHints: [
      hint({ kind: "explicit_test_id", value: "cta-start", scope: "route_version", stability: 0.99, uniqueness: 1 }),
      hint({ kind: "css", value: ".hero button.cta", scope: "cross_capture_candidate", stability: 0.5, uniqueness: 0.6 }),
      hint({ kind: "xpath", value: "//button[1]", scope: "capture_session", stability: 0.2, uniqueness: 0.4 }),
    ],
    evidence: [
      { sourceType: "dom", sourceId: "raw-dom-42", artifactRef: "art://dom/42", confidence: 0.9, claims: ["role=button"] },
      { sourceType: "accessibility", artifactRef: "art://ax/7", confidence: 0.8, claims: ["name"] },
    ],
  });

describe("renderPatchContextView (#12, PRD §6.3/§6.4)", () => {
  it("renders repair facts for a ref: role/name/rect/style, route+viewport, deterministically", () => {
    const nodes = [button()];
    const a = renderPatchContextView(nodes, ["el_cta"], source);
    const b = renderPatchContextView(nodes, ["el_cta"], source);
    expect(a.text).toBe(b.text); // byte-identical
    expect(a.meta).toEqual(b.meta);
    expect(a.meta.view).toBe("patchContext");
    expect(a.meta.policyVersion).toBe(VIEW_POLICY_VERSION);
    expect(a.meta.tokenEstimate).toBe(Math.ceil(a.text.length / 4));
    expect(a.meta.refsResolved).toEqual(["el_cta"]);

    expect(a.text).toContain("/pricing");
    expect(a.text).toContain("Start free trial");
    expect(a.text).toContain("#0a0a0a"); // style/token fact
    expect(a.text).toContain("1280"); // viewport
  });

  it("requires ≥1 resolvable ref: fail-closed empty view naming the unresolved", () => {
    const view = renderPatchContextView([button()], ["el_missing"], source);
    expect(view.text).toBe("");
    expect(view.meta.emptyReason).toMatch(/requires at least one resolvable ref/);
    expect(view.meta.refsUnresolved).toEqual(["el_missing"]);
    expect(view.meta.tokenEstimate).toBe(0);
  });

  it("NEVER emits a generated patch or model-authored content", () => {
    const view = renderPatchContextView([button()], ["el_cta"], source);
    expect(view.text).toContain("\"advisory\":true");
    for (const forbidden of ["\"patch\"", "\"diff\"", "\"sourcePatch\"", "\"code\"", "\"suggestion\"", "\"replacement\""]) {
      expect(view.text).not.toContain(forbidden);
    }
  });

  it("lists durable selector hints only (capture_session excluded), ranked and evidence as pointers", () => {
    const view = renderPatchContextView([button()], ["el_cta"], source);
    // route_version + cross_capture_candidate survive; capture_session xpath dropped.
    expect(view.text).toContain("cta-start");
    expect(view.text).toContain(".hero button.cta");
    expect(view.text).not.toContain("//button[1]");
    // Evidence is artifact pointers, never the raw source id.
    expect(view.text).toContain("art://dom/42");
    expect(view.text).not.toContain("raw-dom-42");
  });

  it("truncates selector hints per ref and reports it", () => {
    const many = node({
      elementRef: "el_many",
      locatorHints: Array.from({ length: 5 }, (_, i) =>
        hint({ kind: "css", value: `.s${i}`, scope: "route_version", stability: 1 - i * 0.1 }),
      ),
    });
    const view = renderPatchContextView([many], ["el_many"], source, { maxHintsPerRef: 2 });
    expect(view.text).toContain("\"selectorHintsTruncated\":true");
    expect(view.text).toContain(".s0");
    expect(view.text).not.toContain(".s4");
  });

  it("surfaces a component-family candidate from a DNA match, and none when absent (no guess)", () => {
    const familyMatch: UIDNAMatch = {
      dnaRef: "fam:PrimaryButton",
      category: "component_family",
      status: "within_tolerance",
      canonical: "fam:PrimaryButton",
      method: "declared_component",
      authoritative: true,
      confidence: 0.95,
      evidence: [],
    };
    const withFamily = node({ elementRef: "el_fam", dnaMatches: [familyMatch] });
    const withView = renderPatchContextView([withFamily], ["el_fam"], source);
    expect(withView.text).toContain("fam:PrimaryButton");
    expect(withView.text).toContain("declared_component");

    const withoutView = renderPatchContextView([button()], ["el_cta"], source);
    expect(withoutView.text).not.toContain("componentFamilyCandidate");
  });

  it("withholds content for sensitive elements: structural facts only, redacted flag set", () => {
    const secret = node({
      elementRef: "el_secret",
      semantics: { role: "textbox", name: "Card number 4111 1111 1111 1111", states: {} },
      style: { color: "#123456" },
      sensitivity: ["pii", "public"] as SensitivityLabel[],
      locatorHints: [hint({ kind: "css", value: ".card-input", scope: "route_version" })],
      evidence: [{ sourceType: "dom", artifactRef: "art://pii/1", confidence: 0.9, claims: [] }],
    });
    const view = renderPatchContextView([secret], ["el_secret"], source);
    expect(view.text).toContain("\"redacted\":true");
    expect(view.text).toContain("textbox"); // structural role kept
    // No content leaks: name, style, selectors, evidence all withheld.
    expect(view.text).not.toContain("4111");
    expect(view.text).not.toContain("#123456");
    expect(view.text).not.toContain(".card-input");
    expect(view.text).not.toContain("art://pii/1");
  });

  it("caps ref entries by budget and reports truncation, deterministically", () => {
    const nodes = [button(), node({ elementRef: "el_b" }), node({ elementRef: "el_c" })];
    const capped = renderPatchContextView(nodes, ["el_cta", "el_b", "el_c"], source, { budget: { maxNodes: 2 } });
    expect(capped.meta.truncated).toBe(true);
    expect(capped.meta.omitted.nodes).toBe(1);
    expect(capped.meta.refsResolved).toHaveLength(2);
    const again = renderPatchContextView(nodes, ["el_cta", "el_b", "el_c"], source, { budget: { maxNodes: 2 } });
    expect(again.text).toBe(capped.text);
  });
});
