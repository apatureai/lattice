/**
 * `queryUiGraph`: the spec-driven view dispatcher (TRD §1, §10; PRD §6.4).
 *
 * Fixtures only: a synthetic capture in, a sealed snapshot, then one bounded
 * view per spec. No model, browser or network. These tests assert the
 * dispatcher's contract: schema-shaped output, derived identity, verified refs,
 * enforced budgets, withheld sensitive content and determinism. They assert no
 * model quality claim.
 */

import { describe, expect, it } from "vitest";
import {
  buildUiGraph,
  formatErrors,
  queryUiGraph,
  syntheticCapture,
  syntheticDna,
  SYNTHETIC_SCREENSHOT_ARTIFACT_REF,
  UIGraphError,
  validateView,
  type UIGraphSnapshot,
  type UIGraphViewSpec,
} from "@apatureai/lattice";

const buildOptions = {
  builderVersion: "ui-graph-builder@0.1.0",
  schemaVersion: "1.0.0" as const,
  relationPolicyVersion: "relations@1",
  dnaProjectionVersion: "dna-projection@1",
  redactionPolicyVersion: "redaction@1",
  useMode: "offline_eval" as const,
  maxNodes: 2000,
  maxPersistedEdgesPerNode: 8,
  repeatedRegionThreshold: 3,
  textPolicy: "truncate" as const,
  includeHiddenExplanatoryNodes: false,
};

async function snapshotOf(
  overrides: Parameters<typeof syntheticCapture>[0] = {},
): Promise<UIGraphSnapshot> {
  const { snapshot } = await buildUiGraph({
    capture: syntheticCapture(overrides),
    dna: syntheticDna(),
    options: buildOptions,
  });
  return snapshot;
}

function spec(kind: UIGraphViewSpec["kind"], extra: Partial<UIGraphViewSpec> = {}): UIGraphViewSpec {
  return {
    kind,
    maxTextTokens: 100_000,
    maxNodes: 400,
    maxEdges: 400,
    maxCrops: 0,
    includeSensitive: false,
    tokenizerProfile: "char-quarter-estimate@1",
    rendererVersion: "ui-graph-renderer@0.2.0",
    ...extra,
  } as UIGraphViewSpec;
}

const base = await snapshotOf();
const refOf = (name: string): string => {
  const node = base.nodes.find((n) => n.semantics.name === name);
  expect(node, `no node named ${name}`).toBeDefined();
  return node!.elementRef;
};

describe("queryUiGraph envelope (TRD §10)", () => {
  it("returns a schema-valid UIGraphView for every view kind", async () => {
    const target = await snapshotOf({ captureId: "cap_target", tableRows: 20 });
    const cases: UIGraphViewSpec[] = [
      spec("summary"),
      spec("actionMap"),
      spec("violations"),
      spec("focus", { refs: [refOf("New review")] }),
      spec("patchContext", { refs: [refOf("Save billing settings")] }),
      spec("diff", { comparisonSnapshotId: target.snapshotId, comparisonContentHash: target.contentHash }),
    ];
    for (const s of cases) {
      const view = queryUiGraph({
        snapshot: base,
        spec: s,
        ...(s.kind === "diff" ? { comparisonSnapshot: target } : {}),
      });
      const result = validateView(view);
      expect(result.valid, `${s.kind}: ${result.valid ? "" : formatErrors(result.errors)}`).toBe(true);
      expect(view.snapshotId).toBe(base.snapshotId);
      expect(view.snapshotContentHash).toBe(base.contentHash);
      expect(view.spec).toEqual(s);
    }
  });

  it("derives identity from the snapshot hash and the normalized spec hash", () => {
    const a = queryUiGraph({ snapshot: base, spec: spec("summary") });
    const b = queryUiGraph({ snapshot: base, spec: spec("summary") });
    expect(a.viewId).toBe(b.viewId);
    expect(a.specHash).toBe(b.specHash);
    expect(a.text).toBe(b.text); // byte-identical
    expect(a.viewId).toMatch(/^ugv_1_[a-f0-9]{32}$/);

    // A different budget is a different question, so a different view identity.
    const narrower = queryUiGraph({ snapshot: base, spec: spec("summary", { maxNodes: 10 }) });
    expect(narrower.specHash).not.toBe(a.specHash);
    expect(narrower.viewId).not.toBe(a.viewId);
  });

  it("reports the node and edge ids the text actually carries", () => {
    const view = queryUiGraph({ snapshot: base, spec: spec("focus", { refs: [refOf("New review")] }) });
    const knownNodeIds = new Set(base.nodes.map((n) => n.nodeId));
    const knownEdgeIds = new Set(base.edges.map((e) => e.edgeId));
    expect(view.includedNodeIds.length).toBeGreaterThan(0);
    for (const id of view.includedNodeIds) expect(knownNodeIds.has(id)).toBe(true);
    for (const id of view.includedEdgeIds) expect(knownEdgeIds.has(id)).toBe(true);
    expect(view.budget.includedNodes).toBe(view.includedNodeIds.length);
    expect(view.budget.includedEdges).toBe(view.includedEdgeIds.length);
    expect(view.budget.serializedBytes).toBe(Buffer.byteLength(view.text, "utf8"));
  });
});

describe("queryUiGraph ref handling (TRD §6/§16)", () => {
  it("refuses a well-formed ref that is not a member of this snapshot", async () => {
    const other = await snapshotOf({ captureId: "cap_other", tableRows: 5 });
    const foreign = other.nodes.at(-1)!.elementRef;
    expect(base.nodes.some((n) => n.elementRef === foreign)).toBe(false);
    try {
      queryUiGraph({ snapshot: base, spec: spec("focus", { refs: [foreign] }) });
      expect.unreachable("should have refused a foreign ref");
    } catch (e) {
      expect(e).toBeInstanceOf(UIGraphError);
      expect((e as UIGraphError).code).toBe("stale_or_foreign_ref");
    }
  });

  it("refuses a malformed ref as an invalid spec, before any rendering", () => {
    try {
      queryUiGraph({ snapshot: base, spec: spec("focus", { refs: ["button#submit"] }) });
      expect.unreachable("should have refused a malformed ref");
    } catch (e) {
      expect((e as UIGraphError).code).toBe("invalid_view_spec");
      expect((e as UIGraphError).issues.map((i) => i.code)).toContain("malformed_ref");
    }
  });

  it("emits only refs that resolve back to snapshot nodes", () => {
    const view = queryUiGraph({ snapshot: base, spec: spec("actionMap") });
    const refs = [...view.text.matchAll(/"ref":"(ug:[a-f0-9]{8}:\d+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    const known = new Set(base.nodes.map((n) => n.elementRef));
    for (const ref of refs) expect(known.has(ref)).toBe(true);
  });
});

describe("queryUiGraph spec validation (fail closed)", () => {
  const rejects = (s: UIGraphViewSpec, issueCode: string, extra: Record<string, unknown> = {}): void => {
    try {
      queryUiGraph({ snapshot: base, spec: s, ...extra });
      expect.unreachable(`should have rejected: expected ${issueCode}`);
    } catch (e) {
      expect(e).toBeInstanceOf(UIGraphError);
      expect((e as UIGraphError).code).toBe("invalid_view_spec");
      expect((e as UIGraphError).issues.map((i) => i.code)).toContain(issueCode);
    }
  };

  it("rejects focus and patchContext without refs", () => {
    rejects(spec("focus"), "refs_required");
    rejects(spec("patchContext"), "refs_required");
  });

  it("rejects includeSensitive true — withheld content is never rendered", () => {
    rejects(spec("summary", { includeSensitive: true as unknown as false }), "include_sensitive_unsupported");
  });

  it("rejects a negative or non-integer budget", () => {
    rejects(spec("summary", { maxNodes: -1 }), "invalid_budget");
    rejects(spec("summary", { maxTextTokens: 1.5 }), "invalid_budget");
  });

  it("rejects a diff whose comparison snapshot is missing or does not match its declared identity", async () => {
    const target = await snapshotOf({ captureId: "cap_target2", tableRows: 3 });
    rejects(
      spec("diff", { comparisonSnapshotId: target.snapshotId, comparisonContentHash: target.contentHash }),
      "comparison_snapshot_required",
    );
    rejects(
      spec("diff", { comparisonSnapshotId: base.snapshotId, comparisonContentHash: base.contentHash }),
      "comparison_identity_mismatch",
      { comparisonSnapshot: target },
    );
  });

  it("rejects an unsealed snapshot outright", () => {
    try {
      queryUiGraph({ snapshot: {} as UIGraphSnapshot, spec: spec("summary") });
      expect.unreachable("should have rejected an unsealed snapshot");
    } catch (e) {
      expect((e as UIGraphError).code).toBe("invalid_snapshot");
    }
  });
});

describe("queryUiGraph budgets truncate, never throw", () => {
  it("reports what a node budget cut", () => {
    const view = queryUiGraph({ snapshot: base, spec: spec("summary", { maxNodes: 5 }) });
    expect(view.truncation.truncated).toBe(true);
    expect(view.truncation.omittedNodeCount).toBeGreaterThan(0);
    expect(view.truncation.reasons.join(" ")).toContain("node_budget");
  });

  it("shrinks deterministically until the text-token budget is met, and says so", () => {
    const generous = queryUiGraph({ snapshot: base, spec: spec("summary") });
    expect(generous.budget.estimatedTextTokens).toBeGreaterThan(500);

    const tight = queryUiGraph({ snapshot: base, spec: spec("summary", { maxTextTokens: 1000 }) });
    // The budget is met, not merely acknowledged.
    expect(tight.budget.estimatedTextTokens).toBeLessThanOrEqual(1000);
    expect(tight.budget.estimatedTextTokens).toBeLessThan(generous.budget.estimatedTextTokens);
    const reasons = tight.truncation.reasons.join(" ");
    expect(reasons).toContain("text_token_budget");
    expect(reasons).toContain("region_budget"); // regions count against the budget too
    expect(tight.text).toBe(queryUiGraph({ snapshot: base, spec: spec("summary", { maxTextTokens: 1000 }) }).text);
  });

  it("bounds the focus neighbourhood's edges", () => {
    const ref = refOf("New review");
    const wide = queryUiGraph({ snapshot: base, spec: spec("focus", { refs: [ref] }) });
    const narrow = queryUiGraph({ snapshot: base, spec: spec("focus", { refs: [ref], maxEdges: 2 }) });
    expect(narrow.includedEdgeIds.length).toBeLessThanOrEqual(2);
    expect(narrow.includedEdgeIds.length).toBeLessThan(wide.includedEdgeIds.length);
    expect(narrow.truncation.omittedEdgeCount).toBeGreaterThan(0);
  });
});

describe("queryUiGraph withholds sensitive content (includeSensitive: false)", () => {
  it("drops the name and text of a node redacted upstream, and says it did", () => {
    // The synthetic capture marks the payment field's source id redacted.
    const redacted = base.nodes.filter((n) => n.sensitivity.includes("redacted"));
    expect(redacted.length).toBeGreaterThan(0);
    const names = redacted.map((n) => n.semantics.name).filter((n): n is string => n !== undefined);
    expect(names).toContain("Card number");

    const view = queryUiGraph({ snapshot: base, spec: spec("summary") });
    expect(view.text).not.toContain("Card number");
    expect(view.text).toContain("withheld:sensitive");
    // A non-sensitive sibling field is still described.
    expect(view.text).toContain("Notification email");
  });
});

describe("queryUiGraph evidence requests are recommendations, never fetches", () => {
  it("plans none — and says why — when no screenshot artifact ref is supplied", () => {
    const view = queryUiGraph({ snapshot: base, spec: spec("focus", { refs: [refOf("New review")], maxCrops: 2 }) });
    expect(view.evidenceRequests).toEqual([]);
    expect(view.warnings.join(" ")).toContain("no screenshotArtifactRef supplied");
  });

  it("plans schema-valid crops for the requested refs when one is supplied", () => {
    const view = queryUiGraph({
      snapshot: base,
      spec: spec("patchContext", { refs: [refOf("New review")], maxCrops: 2 }),
      screenshotArtifactRef: SYNTHETIC_SCREENSHOT_ARTIFACT_REF,
    });
    expect(validateView(view).valid).toBe(true);
    expect(view.evidenceRequests.length).toBeGreaterThan(0);
    for (const request of view.evidenceRequests) {
      expect(request.sourceArtifactRef).toBe(SYNTHETIC_SCREENSHOT_ARTIFACT_REF);
      expect(request.elementRefs).toContain(refOf("New review"));
      expect(request.reason.length).toBeGreaterThan(0);
    }
    expect(view.budget.includedCrops).toBe(view.evidenceRequests.length);
    // A crop is never an image: the view itself still costs zero visual tokens.
    expect(view.budget.estimatedVisualTokens).toBe(0);
  });
});

describe("queryUiGraph view kinds keep their documented boundaries", () => {
  it("violations stays advisory outside a production build against approved DNA", () => {
    const view = queryUiGraph({ snapshot: base, spec: spec("violations") });
    expect(view.text).toContain("\"authoritativeContext\":false");
    expect(view.text).toContain("\"advisory\"");
  });

  it("actionMap is perception only: no action verbs, no browser handles, no source ids", () => {
    const view = queryUiGraph({ snapshot: base, spec: spec("actionMap") });
    expect(view.text).toContain("\"perceptionOnly\":true");
    for (const leak of ["dom_cta", "ax_cta", "backendDomSourceId", "sourceId", "capture_session"]) {
      expect(view.text).not.toContain(leak);
    }
  });

  it("diff separates capture instability from product change", async () => {
    const target = await snapshotOf({ captureId: "cap_moved", navLinks: 7 });
    const view = queryUiGraph({
      snapshot: base,
      spec: spec("diff", { comparisonSnapshotId: target.snapshotId, comparisonContentHash: target.contentHash }),
      comparisonSnapshot: target,
    });
    expect(validateView(view).valid).toBe(true);
    const body = JSON.parse(view.text) as {
      matched: Array<{ baseRef: string; targetRef: string; changeKind: string }>;
      added: string[];
      abstainedCount: number;
    };
    // Elements the capture gave a durable `data-testid` match; the rest abstain
    // rather than guess. Both outcomes must be present for the view to be honest.
    expect(body.matched.length).toBeGreaterThan(0);
    expect(body.abstainedCount).toBeGreaterThan(0);
    for (const m of body.matched) {
      expect(["unchanged", "product_change", "capture_instability"]).toContain(m.changeKind);
    }
    // The extra nav link exists only in the target.
    expect(body.added.length).toBeGreaterThan(0);
  });
});
