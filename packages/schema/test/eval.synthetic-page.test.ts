/**
 * Synthetic capture evidence + the token-efficiency claim (PRD §6.4, TRD §15.1).
 *
 * Two jobs. First, pin the fixture generator: deterministic, structurally valid,
 * and carrying the awkward cases on purpose (a DOM/AX role disagreement, an
 * upstream-redacted field, content below the fold).
 *
 * Second, and this is the one that matters, turn "token-efficient" from a
 * slogan into an enforced invariant. Every rendered view must be strictly
 * smaller than the raw capture it summarizes, on the realistic synthetic page
 * AND on all four golden fixtures. Before views@2 that was false: a summary view
 * was 25-170% LARGER than its own input, because the view text serialized the
 * whole provenance chain. If a future change reintroduces that, this file fails.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildUiGraph,
  canonicalize,
  queryUiGraph,
  syntheticCapture,
  syntheticDna,
  validateCapture,
  type CaptureBundleReadProfile,
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

const build = async (capture: CaptureBundleReadProfile): Promise<UIGraphSnapshot> =>
  (await buildUiGraph({ capture, dna: syntheticDna(), options: buildOptions })).snapshot;

const spec = (kind: UIGraphViewSpec["kind"], extra: Partial<UIGraphViewSpec> = {}): UIGraphViewSpec =>
  ({
    kind,
    maxTextTokens: 1_000_000,
    maxNodes: 10_000,
    maxEdges: 10_000,
    maxCrops: 0,
    includeSensitive: false,
    tokenizerProfile: "char-quarter-estimate@1",
    rendererVersion: "ui-graph-renderer@0.2.0",
    ...extra,
  }) as UIGraphViewSpec;

/**
 * The baseline: canonical bytes of the whole capture bundle, the structured
 * context a prompt would otherwise have to carry wholesale. One number, taken
 * the same way everywhere (tests, `examples/quickstart.mjs`, the README), so the
 * published ratios are reproducible by anyone.
 */
const rawContextBytes = (capture: CaptureBundleReadProfile): number =>
  Buffer.byteLength(canonicalize(capture), "utf8");

describe("syntheticCapture fixture generator", () => {
  it("is deterministic and structurally valid", () => {
    const a = syntheticCapture();
    const b = syntheticCapture();
    expect(canonicalize(a)).toBe(canonicalize(b));
    const validated = validateCapture(a);
    expect(validated.ok, validated.ok ? "" : JSON.stringify(validated.errors)).toBe(true);
    expect(a.documents[0]!.domLayoutNodes.length).toBeGreaterThan(100);
  });

  it("carries a real DOM/AX disagreement that fusion retains", async () => {
    const snapshot = await build(syntheticCapture());
    expect(snapshot.metrics.graph.conflictCount).toBeGreaterThan(0);
    const conflicted = snapshot.nodes.filter((n) => n.flags.some((f) => f.startsWith("conflict:")));
    expect(conflicted.length).toBeGreaterThan(0);
    // Both claims survive on the node: neither source silently won.
    const roles = conflicted[0]!.evidence.flatMap((e) => e.claims).filter((c) => c.startsWith("role="));
    expect(new Set(roles).size).toBeGreaterThan(1);

    const off = await build(syntheticCapture({ roleConflict: false }));
    expect(off.metrics.graph.conflictCount).toBe(0);
  });

  it("marks the upstream-redacted field, and only that field", async () => {
    const snapshot = await build(syntheticCapture());
    const redacted = snapshot.nodes.filter((n) => n.sensitivity.includes("redacted"));
    expect(redacted).toHaveLength(1);
    expect(redacted[0]!.semantics.name).toBe("Card number");
  });

  it("seals a page taller than the viewport, omitting the normalized rect below the fold", async () => {
    const snapshot = await build(syntheticCapture());
    const belowFold = snapshot.nodes.filter(
      (n) => n.geometry.viewportRect !== undefined && n.geometry.viewportRect.y > snapshot.source.viewport.heightCssPx,
    );
    expect(belowFold.length).toBeGreaterThan(0);
    for (const node of belowFold) {
      // No honest [0,1] position exists for it, so the field is absent, never clamped.
      expect(node.geometry.normalizedViewportRect).toBeUndefined();
      // Exact geometry is still there.
      expect(node.geometry.viewportRect).toBeDefined();
      expect(node.geometry.documentRect).toBeDefined();
    }
  });
});

describe("views are smaller than the capture they summarize (views@2)", () => {
  it("every view kind beats the raw capture on the realistic synthetic page", async () => {
    const capture = syntheticCapture();
    const snapshot = await build(capture);
    const raw = rawContextBytes(capture);
    const ctaRef = snapshot.nodes.find((n) => n.semantics.name === "New review")!.elementRef;

    const measured = [
      { kind: "summary", view: queryUiGraph({ snapshot, spec: spec("summary") }) },
      { kind: "actionMap", view: queryUiGraph({ snapshot, spec: spec("actionMap") }) },
      { kind: "violations", view: queryUiGraph({ snapshot, spec: spec("violations") }) },
      { kind: "focus", view: queryUiGraph({ snapshot, spec: spec("focus", { refs: [ctaRef] }) }) },
      { kind: "patchContext", view: queryUiGraph({ snapshot, spec: spec("patchContext", { refs: [ctaRef] }) }) },
    ];

    for (const { kind, view } of measured) {
      expect(view.budget.serializedBytes, `${kind} must be smaller than the raw capture`).toBeLessThan(raw);
      expect(view.budget.serializedBytes).toBeGreaterThan(0);
    }
    // The bounded views are the point: a focused neighbourhood costs an order of
    // magnitude less than the page it was cut from.
    const focus = measured.find((m) => m.kind === "focus")!.view;
    expect(focus.budget.serializedBytes * 10).toBeLessThan(raw);
  });

  it("beats the raw capture on all four golden fixtures too, small as they are", async () => {
    const dir = fileURLToPath(new URL("./fixtures/capture/", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(4);
    for (const file of files) {
      const capture = JSON.parse(readFileSync(dir + file, "utf8")) as CaptureBundleReadProfile;
      const { snapshot } = await buildUiGraph({ capture, options: buildOptions });
      const view = queryUiGraph({ snapshot, spec: spec("summary") });
      expect(view.budget.serializedBytes, `${file} summary must be smaller than its capture`).toBeLessThan(
        rawContextBytes(capture),
      );
    }
  });

  it("keeps provenance out of the view text and in the snapshot, reachable by the same ref", async () => {
    const snapshot = await build(syntheticCapture());
    const view = queryUiGraph({ snapshot, spec: spec("summary") });

    // Provenance is what makes a view fat; none of it belongs in a prompt.
    for (const leaked of ["evidence", "sourceId", "coordinateSpaceId", "frameRect", "artifactRef", "locatorHints"]) {
      expect(view.text, `view text must not carry ${leaked}`).not.toContain(leaked);
    }
    // …but it is intact on the snapshot, under the refs the view emitted.
    const refs = [...view.text.matchAll(/"ref":"(ug:[a-f0-9]{8}:\d+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs.slice(0, 10)) {
      const node = snapshot.nodes.find((n) => n.elementRef === ref);
      expect(node).toBeDefined();
      expect(node!.evidence.length).toBeGreaterThan(0);
    }
  });

  it("retains the conflict marker in the projection, so compression never hides disagreement", async () => {
    const snapshot = await build(syntheticCapture());
    const view = queryUiGraph({ snapshot, spec: spec("summary") });
    expect(view.text).toContain("\"conflicts\":[\"role\"]");
  });
});
