import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assertSnapshotIdentity,
  buildUiGraph,
  canonicalize,
  validateSnapshot,
  type AnyUIDNAReadProfile,
  type BuildUiGraphRequest,
  type CaptureBundleReadProfile,
  type UIGraphBuildOptions,
} from "@apature/ui-graph";

const fixture = <T>(relativePath: string): T => JSON.parse(
  readFileSync(
    fileURLToPath(new URL(`./fixtures/${relativePath}`, import.meta.url)),
    "utf8",
  ),
) as T;

// A capture in the shape the sibling consumer apatureai/judgment-engine emits
// (https://github.com/apatureai/judgment-engine). Frozen JSON, no dependency.
const capture = (): CaptureBundleReadProfile =>
  fixture("capture/judgment-engine.golden.json");
const approvedDna = (): AnyUIDNAReadProfile => fixture("dna/approved.json");
const draftDna = (): AnyUIDNAReadProfile => fixture("dna/experimental-draft.json");

const options = (overrides: Partial<UIGraphBuildOptions> = {}): UIGraphBuildOptions => ({
  builderVersion: "ui-graph-builder@0.1.0",
  schemaVersion: "1.0.0",
  relationPolicyVersion: "relations@1",
  dnaProjectionVersion: "dna-match@1",
  redactionPolicyVersion: "redaction@1",
  useMode: "production",
  maxNodes: 1000,
  maxPersistedEdgesPerNode: 16,
  repeatedRegionThreshold: 3,
  textPolicy: "truncate",
  includeHiddenExplanatoryNodes: false,
  ...overrides,
});

const request = (overrides: Partial<BuildUiGraphRequest> = {}): BuildUiGraphRequest => ({
  capture: capture(),
  dna: approvedDna(),
  options: options(),
  ...overrides,
});

describe("buildUiGraph deterministic pipeline (issue #9)", () => {
  it("builds the consumer-shaped golden into a valid, identity-consistent snapshot", async () => {
    const result = await buildUiGraph(request());
    const { snapshot, diagnostics } = result;

    expect(validateSnapshot(snapshot).valid).toBe(true);
    expect(() => assertSnapshotIdentity(snapshot)).not.toThrow();
    expect(snapshot.source).toMatchObject({
      captureId: "je_job_01hxyz_route_home_desktop",
      captureSchemaVersion: "1.0.0",
      captureVersion: "playwright-capture@3",
      dnaVersion: "dna@2026-06-01",
      dnaState: "approved",
      dnaUseMode: "production",
    });
    expect(snapshot.dnaProjection).toMatchObject({
      dnaVersion: "dna@2026-06-01",
      state: "approved",
      useMode: "production",
    });
    expect(snapshot.metrics.graph.nodes).toBe(snapshot.nodes.length);
    expect(snapshot.metrics.graph.edges).toBe(snapshot.edges.length);
    expect(diagnostics.canonicalJsonBytes).toBe(Buffer.byteLength(canonicalize(snapshot), "utf8"));
    expect(diagnostics.counters.graph_nodes).toBe(snapshot.nodes.length);
  });

  it("assigns honest snapshot-local refs, locator hints, geometry, and evidence", async () => {
    const { snapshot } = await buildUiGraph(request());
    const refs = new Set(snapshot.nodes.map((node) => node.elementRef));
    const nodeIds = new Set(snapshot.nodes.map((node) => node.nodeId));

    expect(refs.size).toBe(snapshot.nodes.length);
    for (const node of snapshot.nodes) {
      expect(node.elementRef).toMatch(/^ug:[a-f0-9]{8}:[0-9]+$/);
      expect(node.locatorHints.length).toBeGreaterThan(0);
      expect(node.evidence.length).toBeGreaterThan(0);
      expect(node.geometry.frameId.length).toBeGreaterThan(0);
      expect(snapshot.nodes.find((candidate) => candidate.elementRef === node.elementRef)?.nodeId)
        .toBe(node.nodeId);
    }
    for (const edge of snapshot.edges) {
      expect(nodeIds.has(edge.fromNodeId)).toBe(true);
      expect(nodeIds.has(edge.toNodeId)).toBe(true);
    }
    for (const region of snapshot.regions) {
      expect(nodeIds.has(region.rootNodeId)).toBe(true);
      expect(region.memberNodeIds.every((nodeId) => nodeIds.has(nodeId))).toBe(true);
    }
  });

  it("is byte-stable across independent runs while diagnostics remain outside the hash", async () => {
    const first = await buildUiGraph(request());
    const second = await buildUiGraph(request());
    expect(canonicalize(first.snapshot)).toBe(canonicalize(second.snapshot));
    expect(first.snapshot.contentHash).toBe(second.snapshot.contentHash);
    expect(first.snapshot.snapshotId).toBe(second.snapshot.snapshotId);
    expect(first.diagnostics.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("binds capture health, approved DNA digest, and use mode into snapshot identity", async () => {
    const baseline = await buildUiGraph(request());
    const changedCapture = capture();
    changedCapture.pageHealth.stable = false;
    changedCapture.pageHealth.reasons = ["layout_shift"];
    const unhealthy = await buildUiGraph(request({ capture: changedCapture }));
    const shadow = await buildUiGraph(request({ options: options({ useMode: "shadow" }) }));
    const changedDna = approvedDna();
    changedDna.dnaContentDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newDna = await buildUiGraph(request({ dna: changedDna }));

    expect(unhealthy.snapshot.contentHash).not.toBe(baseline.snapshot.contentHash);
    expect(unhealthy.snapshot.warnings.map((warning) => warning.code)).toContain("capture_unstable");
    expect(shadow.snapshot.contentHash).not.toBe(baseline.snapshot.contentHash);
    expect(shadow.snapshot.source.dnaUseMode).toBe("shadow");
    expect(shadow.snapshot.dnaProjection?.authoritativeMatchCount).toBe(0);
    expect(newDna.snapshot.contentHash).not.toBe(baseline.snapshot.contentHash);
  });

  it("records canonical DNA token refs rather than snapshot refs in matches", async () => {
    const { snapshot } = await buildUiGraph(request());
    const matches = snapshot.nodes.flatMap((node) => node.dnaMatches);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((match) => match.dnaRef === "color.primary")).toBe(true);
    expect(matches.every((match) => !match.dnaRef.startsWith("ug:"))).toBe(true);
  });

  it("builds supplied derived observations without acquiring parser or model capability", async () => {
    const derived = fixture<CaptureBundleReadProfile>("capture/with-derived.json");
    const { snapshot } = await buildUiGraph(request({ capture: derived, dna: undefined }));
    expect(snapshot.source.derivedProviders).toHaveLength(4);
    expect(snapshot.metrics.source.visualCandidates).toBeGreaterThanOrEqual(0);
    expect(snapshot.metrics.coverage.parserOnlyAreaRatio).toBeGreaterThanOrEqual(0);
    expect(snapshot.metrics.coverage.parserOnlyAreaRatio).toBeLessThanOrEqual(1);
  });

  it("enforces maxNodes in the canonical snapshot when repeated regions can be summarized", async () => {
    const boundedCapture = capture();
    const repeated = boundedCapture.documents[0]!.domLayoutNodes.find((node) => node.sourceId === "dom_cta")!;
    for (let index = 1; index <= 3; index += 1) {
      boundedCapture.documents[0]!.domLayoutNodes.push({
        ...repeated,
        sourceId: `dom_cta_${index}`,
        bounds: { ...repeated.bounds!, y: repeated.bounds!.y + index * 64 },
      });
    }
    const { snapshot } = await buildUiGraph(request({
      capture: boundedCapture,
      options: options({ maxNodes: 2 }),
    }));
    expect(snapshot.nodes.length).toBeLessThanOrEqual(2);
    expect(snapshot.metrics.graph.nodes).toBe(snapshot.nodes.length);
    expect(snapshot.warnings.some((warning) => warning.code === "node_cap_exceeded")).toBe(true);
  });

  it.each(["minimal.json", "multi-frame.json", "with-derived.json"])(
    "builds the frozen capture corpus entry %s",
    async (name) => {
      const frozen = fixture<CaptureBundleReadProfile>(`capture/${name}`);
      const { snapshot } = await buildUiGraph(request({ capture: frozen, dna: undefined }));
      expect(validateSnapshot(snapshot).valid).toBe(true);
      expect(() => assertSnapshotIdentity(snapshot)).not.toThrow();
    },
  );

  it("does not mutate caller-owned materialized capture or DNA objects", async () => {
    const input = request();
    const before = canonicalize(input);
    await buildUiGraph(input);
    expect(canonicalize(input)).toBe(before);
  });
});

describe("buildUiGraph fail-closed contract", () => {
  it("rejects an unsupported producer major before returning any snapshot", async () => {
    const bad = capture();
    bad.schemaVersion = "2.0.0";
    await expect(buildUiGraph(request({ capture: bad }))).rejects.toMatchObject({
      code: "invalid_capture",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unsupported_source_major" }),
      ]),
    });
  });

  it("rejects non-approved DNA in production", async () => {
    await expect(buildUiGraph(request({ dna: draftDna() }))).rejects.toMatchObject({
      code: "invalid_dna",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "non_approved_dna_in_production" }),
      ]),
    });
  });

  it("rejects malformed derived provenance through the public entry point", async () => {
    const bad = fixture<CaptureBundleReadProfile>("capture/with-derived.json");
    const observation = bad.derivedObservations?.[0];
    if (observation !== undefined) observation.provider = "";
    await expect(buildUiGraph(request({ capture: bad, dna: undefined }))).rejects.toMatchObject({
      code: "invalid_capture",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "derived_observation_missing_provenance" }),
      ]),
    });
  });

  it("rejects unsupported output schema and invalid limits", async () => {
    await expect(buildUiGraph(request({
      options: options({ schemaVersion: "2.0.0", maxNodes: 0 }),
    }))).rejects.toMatchObject({
      code: "invalid_build_options",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unsupported_output_schema" }),
        expect.objectContaining({ code: "invalid_limit" }),
      ]),
    });
  });
});
