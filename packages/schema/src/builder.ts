/**
 * Deterministic `buildUiGraph` composition (issue #9, TRD §8).
 *
 * This module wires the already-pure stages into the public builder. It owns no
 * browser, storage, network, model, or wall-clock state. Wall-clock and timing
 * values are returned only in diagnostics and never enter the sealed snapshot.
 */

import type { BuildUiGraphRequest, UIGraphBuildResult } from "./api.js";
import {
  validateCaptureBundle,
  validateDnaProfile,
  type AdapterIssue,
} from "./adapter.js";
import { canonicalize, sealSnapshot, sha256 } from "./canonical.js";
import type {
  AnyUIDNAReadProfile,
  CaptureAccessibilityNode,
  CaptureBundleReadProfile,
  CaptureDomLayoutNode,
} from "./readprofile.js";
import {
  buildHierarchy,
  buildRelations,
  fuseCapture,
  normalizeCapture,
  projectDna,
  validateCapture,
  type FusedNode,
  type NodeHierarchy,
  type NormalizedCapture,
  type PipelineIssue,
} from "./pipeline/index.js";
import {
  SCHEMA_VERSION,
  type LocatorHint,
  type EvidenceClaim,
  type Rect,
  type UIRegion,
  type UIGraphEdge,
  type UIGraphMetrics,
  type UIGraphNode,
  type UIGraphSnapshotDraft,
  type UIGraphWarning,
} from "./types.js";

export type BuildPipelineFailureCode =
  | "invalid_build_options"
  | "invalid_capture"
  | "invalid_dna"
  | "invalid_snapshot";

export class BuildPipelineFailure extends Error {
  readonly code: BuildPipelineFailureCode;
  readonly issues: ReadonlyArray<{ code: string; message: string }>;

  constructor(
    code: BuildPipelineFailureCode,
    message: string,
    issues: ReadonlyArray<{ code: string; message: string }> = [],
  ) {
    super(message);
    this.name = "BuildPipelineFailure";
    this.code = code;
    this.issues = issues;
  }
}

const compareStrings = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const hashHex = (value: unknown, length = 16): string =>
  sha256(canonicalize(value)).slice("sha256:".length, "sha256:".length + length);
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function validateOptions(request: BuildUiGraphRequest): void {
  const { options } = request;
  const issues: Array<{ code: string; message: string }> = [];
  const requiredVersions = [
    "builderVersion",
    "schemaVersion",
    "relationPolicyVersion",
    "dnaProjectionVersion",
    "redactionPolicyVersion",
  ] as const;
  for (const key of requiredVersions) {
    if (typeof options[key] !== "string" || options[key].trim().length === 0) {
      issues.push({ code: "missing_version", message: `${key} must be a non-empty string` });
    }
  }
  if (options.schemaVersion !== SCHEMA_VERSION) {
    issues.push({
      code: "unsupported_output_schema",
      message: `schemaVersion ${options.schemaVersion} is unsupported; expected ${SCHEMA_VERSION}`,
    });
  }
  for (const key of ["maxNodes", "maxPersistedEdgesPerNode", "repeatedRegionThreshold"] as const) {
    if (!Number.isSafeInteger(options[key]) || options[key] <= 0) {
      issues.push({ code: "invalid_limit", message: `${key} must be a positive safe integer` });
    }
  }
  if (issues.length > 0) {
    throw new BuildPipelineFailure("invalid_build_options", "UI Graph build options are invalid", issues);
  }
}

function adapterIssues(issues: readonly AdapterIssue[]): Array<{ code: string; message: string }> {
  return issues.map((issue) => ({ code: issue.code, message: `${issue.path}: ${issue.message}` }));
}

function pipelineIssues(issues: readonly PipelineIssue[]): Array<{ code: string; message: string }> {
  return issues.map((issue) => ({ code: issue.code, message: issue.message }));
}

function documentFallback(capture: CaptureBundleReadProfile): FusedNode {
  const frameId = capture.documents[0]?.frameId ?? "root";
  const viewportRect: Rect = {
    x: 0,
    y: 0,
    width: capture.viewport.widthCssPx,
    height: capture.viewport.heightCssPx,
  };
  return {
    candidateId: "cand_0000",
    kind: "dom",
    frameId,
    geometry: {
      frameId,
      frameRect: viewportRect,
      documentRect: viewportRect,
      viewportRect,
      normalizedViewportRect: { x: 0, y: 0, width: 1, height: 1 },
      coordinateSpaceId: `cs_frame_${frameId}`,
      visibility: "visible",
      clipped: false,
    },
    role: { value: "document", confidence: 0.5, conflict: false },
    evidence: [{
      sourceType: "layout",
      sourceId: capture.captureId,
      coordinateSpaceId: "cs_viewport",
      confidence: 0.5,
      claims: ["document_bounds", "no_element_evidence"],
    }],
    flags: ["partial:no_element_evidence"],
    confidence: 0.5,
  };
}

function preferredLinkage(node: FusedNode): string[] {
  return node.evidence
    .map((claim) => `${claim.sourceType}:${claim.sourceId ?? claim.artifactRef ?? "unknown"}`)
    .sort(compareStrings);
}

function frameSlug(frameId: string): string {
  const safe = frameId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 20);
  return safe.length > 0 ? safe : hashHex(frameId, 8);
}

/** Node IDs contain reading order but are not derived from array position alone. */
function assignNodeIds(
  nodes: readonly FusedNode[],
  hierarchy: readonly NodeHierarchy[],
): Map<string, string> {
  const byCandidate = new Map(nodes.map((node) => [node.candidateId, node]));
  const parentOf = new Map(hierarchy.map((entry) => [entry.candidateId, entry.parentNodeId]));
  const identityMemo = new Map<string, string>();

  const identityOf = (candidateId: string): string => {
    const cached = identityMemo.get(candidateId);
    if (cached !== undefined) return cached;
    const node = byCandidate.get(candidateId);
    if (node === undefined) return "missing";
    const parent = parentOf.get(candidateId);
    const identity = hashHex({
      frameKey: node.frameId,
      preferredSourceLinkage: preferredLinkage(node),
      normalizedAncestorIdentity: parent === undefined ? "root" : identityOf(parent),
      kind: node.kind,
    });
    identityMemo.set(candidateId, identity);
    return identity;
  };

  const ids = new Map<string, string>();
  for (const node of nodes) {
    const ordinal = node.candidateId.replace(/^cand_/, "");
    ids.set(
      node.candidateId,
      `n_${frameSlug(node.frameId)}_${ordinal}_${identityOf(node.candidateId)}`,
    );
  }
  return ids;
}

function remapRegions(
  regions: readonly UIRegion[],
  nodeIds: ReadonlyMap<string, string>,
): { regions: UIRegion[]; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  for (const region of regions) {
    const rootNodeId = nodeIds.get(region.rootNodeId) ?? region.rootNodeId;
    const memberNodeIds = region.memberNodeIds
      .map((id) => nodeIds.get(id) ?? id)
      .sort(compareStrings);
    ids.set(
      region.regionId,
      `r_${hashHex({ kind: region.kind, rootNodeId, memberNodeIds })}`,
    );
  }
  return {
    ids,
    regions: regions.map((region) => ({
      ...region,
      regionId: ids.get(region.regionId)!,
      rootNodeId: nodeIds.get(region.rootNodeId) ?? region.rootNodeId,
      memberNodeIds: region.memberNodeIds
        .map((id) => nodeIds.get(id) ?? id)
        .sort(compareStrings),
      evidence: ensureEvidenceClaims(region.evidence, `region:${region.kind}`),
    })),
  };
}

function ensureEvidenceClaims(
  evidence: readonly EvidenceClaim[],
  fallbackClaim: string,
): EvidenceClaim[] {
  return evidence.map((claim) => ({
    ...claim,
    claims: claim.claims.length > 0 ? [...claim.claims] : [fallbackClaim],
  }));
}

function sourceIndexes(capture: CaptureBundleReadProfile, normalized: NormalizedCapture): {
  normalizedById: Map<string, NormalizedCapture["nodes"][number]>;
  domById: Map<string, CaptureDomLayoutNode>;
  axById: Map<string, CaptureAccessibilityNode>;
  redacted: Set<string>;
} {
  const domById = new Map<string, CaptureDomLayoutNode>();
  const axById = new Map<string, CaptureAccessibilityNode>();
  for (const document of capture.documents) {
    for (const node of document.domLayoutNodes) domById.set(node.sourceId, node);
    for (const node of document.accessibilityNodes) axById.set(node.sourceId, node);
  }
  return {
    normalizedById: new Map(normalized.nodes.map((node) => [node.sourceId, node])),
    domById,
    axById,
    redacted: new Set(capture.redaction.redactedSourceIds),
  };
}

function evidenceSource(node: FusedNode, sourceType: string): string | undefined {
  return node.evidence.find((claim) => claim.sourceType === sourceType)?.sourceId;
}

function firstValue(
  record: Record<string, string | number> | undefined,
  names: readonly string[],
): string | number | undefined {
  if (record === undefined) return undefined;
  for (const [key, value] of Object.entries(record)) {
    if (names.some((name) => key.toLowerCase() === name.toLowerCase())) return value;
  }
  return undefined;
}

function numeric(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function styleOf(
  node: FusedNode,
  indexes: ReturnType<typeof sourceIndexes>,
): UIGraphNode["style"] {
  const domId = evidenceSource(node, "dom");
  const normalized = domId === undefined ? undefined : indexes.normalizedById.get(domId);
  const dom = domId === undefined ? undefined : indexes.domById.get(domId);
  const facts = dom?.styleFacts;
  const style: UIGraphNode["style"] = {};

  const colorByName = (name: string): string | undefined => {
    const hit = Object.entries(normalized?.colors ?? {})
      .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    return hit?.canonical ?? undefined;
  };
  const lengthByNames = (names: readonly string[]): number | undefined => {
    const hit = Object.entries(normalized?.lengths ?? {})
      .find(([key]) => names.some((name) => key.toLowerCase() === name.toLowerCase()))?.[1];
    return hit?.valueCssPx ?? undefined;
  };

  style.color = colorByName("color");
  style.backgroundColor = colorByName("backgroundColor");
  const fontFamily = firstValue(facts, ["fontFamily", "font-family"]);
  if (typeof fontFamily === "string") style.fontFamily = fontFamily;
  style.fontSizeCssPx = lengthByNames(["fontSizeCssPx", "fontSize", "font-size"]);
  style.fontWeight = numeric(firstValue(facts, ["fontWeight", "font-weight"]));
  style.lineHeightCssPx = lengthByNames(["lineHeightCssPx", "lineHeight", "line-height"]);
  style.opacity = numeric(firstValue(facts, ["opacity"]));
  const display = firstValue(facts, ["display"]);
  if (typeof display === "string") style.display = display;
  const position = firstValue(facts, ["position"]);
  if (typeof position === "string") style.position = position;
  if (dom?.zIndex !== undefined) style.zIndex = dom.zIndex;

  const radii = Object.entries(normalized?.lengths ?? {})
    .filter(([key, value]) => key.toLowerCase().includes("borderradius") && value.valueCssPx !== null)
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([, value]) => value.valueCssPx!);
  if (radii.length > 0) style.borderRadiusCssPx = radii;

  const spacing = Object.entries(normalized?.lengths ?? {})
    .filter(([key, value]) => /^(margin|padding|gap|rowgap|columngap)/i.test(key) && value.valueCssPx !== null)
    .sort(([a], [b]) => compareStrings(a, b));
  if (spacing.length > 0) {
    style.spacing = Object.fromEntries(spacing.map(([key, value]) => [key, value.valueCssPx!]));
  }

  return Object.fromEntries(
    Object.entries(style).filter(([, value]) => value !== undefined),
  ) as UIGraphNode["style"];
}

const INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "combobox", "link", "listbox", "menuitem", "option",
  "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox",
]);

function nodeKind(node: FusedNode, dom: CaptureDomLayoutNode | undefined): UIGraphNode["kind"] {
  const role = node.role?.value?.toLowerCase();
  const tag = dom?.tag?.toLowerCase();
  if (role === "document") return "document";
  if (role === "img" || tag === "img") return "image";
  if (tag === "canvas") return "canvas";
  if (node.kind === "text") return "text";
  if (node.kind === "visual") return "visual_candidate";
  if (role !== undefined && INTERACTIVE_ROLES.has(role)) return "control";
  return "element";
}

function affordanceForRole(role: string | undefined): UIGraphNode["affordances"][number] | undefined {
  switch (role?.toLowerCase()) {
    case "link": return "navigate";
    case "textbox":
    case "searchbox":
    case "spinbutton": return "type";
    case "checkbox":
    case "radio":
    case "switch": return "toggle";
    case "combobox":
    case "listbox":
    case "option": return "select";
    case "button":
    case "menuitem":
    case "tab": return "click";
    case "slider": return "drag";
    default: return role === undefined ? undefined : "focus";
  }
}

/**
 * The normalized viewport rect is a [0,1] contract (TRD §7): it says WHERE in
 * the viewport an element sits. An element scrolled out of the viewport has no
 * honest answer, and clamping would assert a position it does not occupy — so
 * the field is OMITTED (the schema makes it optional) and the exact
 * `documentRect`/`viewportRect` carry the geometry instead. Without this, any
 * capture of a page taller than one screen failed to seal.
 */
function normalizedIfInViewport(rect: Rect | undefined): Rect | undefined {
  if (rect === undefined) return undefined;
  const within = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= 1;
  return within(rect.x) && within(rect.y) && within(rect.width) && within(rect.height)
    ? rect
    : undefined;
}

function visibleRect(rect: Rect | undefined, viewport: Rect | undefined): Rect | undefined {
  if (rect === undefined || viewport === undefined) return undefined;
  const x = Math.max(rect.x, viewport.x);
  const y = Math.max(rect.y, viewport.y);
  const right = Math.min(rect.x + rect.width, viewport.x + viewport.width);
  const bottom = Math.min(rect.y + rect.height, viewport.y + viewport.height);
  if (right <= x || bottom <= y) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Durable DOM attributes → cross-capture locator hints, in descending order of
 * how well each survives a re-render. These are the only hints the lineage
 * matcher counts as an explicit identity (TRD §6.4): a capture that reports no
 * attributes yields no explicit-id feature, and cross-snapshot matching can then
 * only abstain.
 */
const ATTRIBUTE_HINTS: ReadonlyArray<{
  readonly attribute: string;
  readonly kind: LocatorHint["kind"];
  readonly scope: LocatorHint["scope"];
  readonly uniqueness: number;
  readonly stability: number;
}> = [
  { attribute: "data-testid", kind: "explicit_test_id", scope: "cross_capture_candidate", uniqueness: 0.98, stability: 0.95 },
  { attribute: "id", kind: "stable_dom_id", scope: "cross_capture_candidate", uniqueness: 0.9, stability: 0.85 },
  { attribute: "href", kind: "href_or_form_name", scope: "route_version", uniqueness: 0.7, stability: 0.8 },
  { attribute: "name", kind: "href_or_form_name", scope: "route_version", uniqueness: 0.65, stability: 0.8 },
];

function locatorHints(
  node: FusedNode,
  nodeId: string,
  parentNodeId: string | undefined,
  dom: CaptureDomLayoutNode | undefined,
): LocatorHint[] {
  const hints: LocatorHint[] = [];
  for (const spec of ATTRIBUTE_HINTS) {
    const value = dom?.attributes?.[spec.attribute];
    if (value === undefined || value.length === 0) continue;
    hints.push({
      kind: spec.kind,
      value,
      scope: spec.scope,
      uniqueness: spec.uniqueness,
      stability: spec.stability,
      confidence: clamp01(node.confidence),
    });
  }
  if (node.role?.value !== undefined && node.name?.value !== undefined) {
    hints.push({
      kind: "role_name",
      value: `${node.frameId}:${node.role.value}:${node.name.value}`,
      scope: "route_version",
      uniqueness: 0.85,
      stability: 0.8,
      confidence: clamp01(Math.min(node.role.confidence, node.name.confidence)),
    });
  }
  if (node.text?.value !== undefined && node.text.value.length > 0) {
    hints.push({
      kind: "text",
      value: `sha256:${hashHex(node.text.value, 32)}`,
      scope: "route_version",
      uniqueness: 0.55,
      stability: 0.5,
      confidence: clamp01(node.text.confidence),
    });
  }
  hints.push({
    kind: "structural_path",
    value: `${node.frameId}/${parentNodeId ?? "root"}/${nodeId}`,
    scope: "route_version",
    uniqueness: 0.9,
    stability: 0.6,
    confidence: clamp01(node.confidence),
  });
  if (node.geometry !== undefined) {
    const rect = node.geometry.viewportRect;
    hints.push({
      kind: "geometry",
      value: `${node.frameId}:${rect.x},${rect.y},${rect.width},${rect.height}`,
      scope: "capture_session",
      uniqueness: 0.25,
      stability: 0.2,
      confidence: clamp01(node.confidence),
    });
  }
  return hints;
}

function createGraphNodes(
  fused: readonly FusedNode[],
  hierarchy: readonly NodeHierarchy[],
  nodeIds: ReadonlyMap<string, string>,
  regionIds: ReadonlyMap<string, string>,
  capture: CaptureBundleReadProfile,
  normalized: NormalizedCapture,
): UIGraphNode[] {
  const hierarchyById = new Map(hierarchy.map((entry) => [entry.candidateId, entry]));
  const indexes = sourceIndexes(capture, normalized);

  return fused.map((node, ordinal) => {
    const hierarchyEntry = hierarchyById.get(node.candidateId);
    const nodeId = nodeIds.get(node.candidateId)!;
    const parentNodeId = hierarchyEntry?.parentNodeId === undefined
      ? undefined
      : nodeIds.get(hierarchyEntry.parentNodeId);
    const domId = evidenceSource(node, "dom");
    const axId = evidenceSource(node, "accessibility");
    const dom = domId === undefined ? undefined : indexes.domById.get(domId);
    const ax = axId === undefined ? undefined : indexes.axById.get(axId);
    const style = styleOf(node, indexes);
    const evidence = ensureEvidenceClaims(node.evidence, "source_observation");
    if (domId !== undefined && Object.keys(style).length > 0) {
      evidence.push({
        sourceType: "computed_style",
        sourceId: domId,
        confidence: 0.9,
        claims: Object.keys(style).sort(compareStrings).map((key) => `style:${key}`),
      });
    }
    const redacted = evidence.some((claim) =>
      claim.sourceId !== undefined && indexes.redacted.has(claim.sourceId),
    );
    const viewportBounds: Rect = {
      x: 0,
      y: 0,
      width: capture.viewport.widthCssPx,
      height: capture.viewport.heightCssPx,
    };
    const geometry: UIGraphNode["geometry"] = {
      frameId: node.frameId,
      clipped: node.geometry?.clipped ?? false,
    };
    if (node.geometry !== undefined) {
      geometry.documentRect = node.geometry.documentRect;
      geometry.viewportRect = node.geometry.viewportRect;
      geometry.visibleRect = visibleRect(node.geometry.viewportRect, viewportBounds);
      const normalized = normalizedIfInViewport(node.geometry.normalizedViewportRect);
      if (normalized !== undefined) geometry.normalizedViewportRect = normalized;
    }
    if (dom?.paintOrder !== undefined) geometry.paintOrder = dom.paintOrder;

    const semantics: UIGraphNode["semantics"] = { states: ax?.state ?? {} };
    if (node.role?.value !== undefined) semantics.role = node.role.value;
    if (node.name?.value !== undefined) semantics.name = node.name.value;
    if (ax?.description !== undefined) semantics.description = ax.description;
    if (node.text?.value !== undefined) semantics.text = node.text.value;

    const kind = nodeKind(node, dom);
    const affordance = kind === "control" && ax?.state?.disabled !== true
      ? affordanceForRole(node.role?.value)
      : undefined;
    const affordances = affordance === undefined ? [] : [affordance];

    const graphNode: UIGraphNode = {
      nodeId,
      // The canonical sealer replaces this provisional, non-semantic ref after
      // DNA projection. It is stripped before sealing below.
      elementRef: `ug:00000000:${ordinal}`,
      kind,
      regionIds: (hierarchyEntry?.regionIds ?? [])
        .map((id) => regionIds.get(id) ?? id)
        .sort(compareStrings),
      semantics,
      geometry,
      style,
      affordances,
      dnaMatches: [],
      locatorHints: locatorHints(node, nodeId, parentNodeId, dom),
      evidence,
      sensitivity: [redacted ? "redacted" : "tenant_private"],
      confidence: clamp01(node.confidence),
      flags: [...node.flags].sort(compareStrings),
    };
    if (parentNodeId !== undefined) graphNode.parentNodeId = parentNodeId;
    return graphNode;
  });
}

function remapEdges(
  edges: readonly UIGraphEdge[],
  nodeIds: ReadonlyMap<string, string>,
  fused: readonly FusedNode[],
): UIGraphEdge[] {
  const fusedById = new Map(fused.map((node) => [node.candidateId, node]));
  return edges.map((edge) => {
    const fromNodeId = nodeIds.get(edge.fromNodeId) ?? edge.fromNodeId;
    const toNodeId = nodeIds.get(edge.toNodeId) ?? edge.toNodeId;
    return {
      ...edge,
      edgeId: `e_${hashHex({ kind: edge.kind, fromNodeId, toNodeId, directed: edge.directed })}`,
      fromNodeId,
      toNodeId,
      evidence: (edge.evidence.length > 0
        ? ensureEvidenceClaims(edge.evidence, `relation:${edge.kind}`)
        : ensureEvidenceClaims(
            fusedById.get(edge.fromNodeId)?.evidence.slice(0, 1) ?? [],
            `relation:${edge.kind}`,
          )).map((claim) => ({
            ...claim,
            claims: [...new Set([...claim.claims, `relation:${edge.kind}`])],
          })),
    };
  });
}

function buildMetrics(
  capture: CaptureBundleReadProfile,
  nodes: readonly FusedNode[],
  edges: readonly UIGraphEdge[],
  regions: readonly UIRegion[],
): UIGraphMetrics {
  const domNodes = capture.documents.reduce((sum, document) => sum + document.domLayoutNodes.length, 0);
  const accessibilityNodes = capture.documents.reduce(
    (sum, document) => sum + document.accessibilityNodes.length,
    0,
  );
  const visualCandidates = nodes.filter((node) => node.kind === "visual").length;
  const geometryNodes = nodes.filter((node) => node.geometry !== undefined);
  const structured = geometryNodes.filter((node) => node.kind !== "visual").length;
  const parserOnlyWithGeometry = geometryNodes.filter((node) => node.kind === "visual").length;
  const interactive = nodes.filter((node) =>
    node.role?.value !== undefined && INTERACTIVE_ROLES.has(node.role.value.toLowerCase()),
  );
  const accessibleInteractive = interactive.filter((node) =>
    node.evidence.some((claim) => claim.sourceType === "accessibility"),
  ).length;
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.fromNodeId, (degree.get(edge.fromNodeId) ?? 0) + 1);
    degree.set(edge.toNodeId, (degree.get(edge.toNodeId) ?? 0) + 1);
  }
  return {
    source: { domNodes, accessibilityNodes, visualCandidates },
    graph: {
      nodes: nodes.length,
      edges: edges.length,
      regions: regions.length,
      maxDegree: degree.size === 0 ? 0 : Math.max(...degree.values()),
      conflictCount: nodes.reduce(
        (sum, node) => sum + node.flags.filter((flag) => flag.startsWith("conflict:")).length,
        0,
      ),
    },
    coverage: {
      structuredVisibleAreaRatio: geometryNodes.length === 0 ? 0 : structured / geometryNodes.length,
      parserOnlyAreaRatio: geometryNodes.length === 0 ? 0 : parserOnlyWithGeometry / geometryNodes.length,
      accessibleInteractiveRatio: interactive.length === 0 ? 1 : accessibleInteractive / interactive.length,
    },
  };
}

function warningOf(issue: PipelineIssue): UIGraphWarning {
  return { code: issue.code, severity: issue.severity, message: issue.message };
}

function buildWarnings(
  capture: CaptureBundleReadProfile,
  issues: readonly PipelineIssue[],
  truncated: boolean,
  omittedNodeCount: number,
): UIGraphWarning[] {
  const warnings = issues.map(warningOf);
  if (!capture.pageHealth.stable) {
    warnings.push({ code: "capture_unstable", severity: "warning", message: "capture did not reach visual quiescence" });
  }
  if (capture.pageHealth.partial) {
    warnings.push({ code: "capture_partial", severity: "warning", message: "capture is partial" });
  }
  if ((capture.screenshotEvidence?.length ?? 0) === 0) {
    warnings.push({
      code: "visual_evidence_unavailable",
      severity: "info",
      message: "no screenshot evidence was supplied; structured graph remains available",
    });
  }
  for (const reason of [...capture.pageHealth.reasons].sort(compareStrings)) {
    warnings.push({ code: "page_health", severity: "warning", message: reason });
  }
  if (truncated) {
    warnings.push({
      code: "node_cap_exceeded",
      severity: "warning",
      message: `${omittedNodeCount} nodes summarized by the configured node cap`,
    });
  }
  const unique = new Map<string, UIGraphWarning>();
  for (const warning of warnings) {
    unique.set(`${warning.code}\u0000${warning.severity}\u0000${warning.message}`, warning);
  }
  return [...unique.values()].sort((a, b) =>
    compareStrings(a.code, b.code) || compareStrings(a.message, b.message),
  );
}

function sourceMetadata(
  capture: CaptureBundleReadProfile,
  dna: AnyUIDNAReadProfile | undefined,
  effectiveUseMode: BuildUiGraphRequest["options"]["useMode"],
): UIGraphSnapshotDraft["source"] {
  const source: UIGraphSnapshotDraft["source"] = {
    captureId: capture.captureId,
    captureSchemaVersion: capture.schemaVersion,
    captureVersion: capture.captureVersion,
    repository: capture.repository,
    route: capture.route,
    viewport: capture.viewport,
    derivedProviders: (capture.derivedObservations ?? [])
      .map((observation) => ({
        kind: observation.kind,
        provider: observation.provider,
        providerVersion: observation.providerVersion,
      }))
      .sort((a, b) =>
        compareStrings(a.kind, b.kind) ||
        compareStrings(a.provider, b.provider) ||
        compareStrings(a.providerVersion, b.providerVersion),
      ),
  };
  if (capture.headSha !== undefined) source.headSha = capture.headSha;
  if (dna !== undefined) {
    source.dnaVersion = dna.dnaVersion;
    source.dnaProjectionSchemaVersion = dna.projectionSchemaVersion;
    source.dnaContentDigest = dna.dnaContentDigest;
    source.dnaState = dna.state;
    source.dnaUseMode = effectiveUseMode;
  }
  return source;
}

/** Execute the complete deterministic build and return non-semantic diagnostics. */
export async function executeBuild(request: BuildUiGraphRequest): Promise<UIGraphBuildResult> {
  validateOptions(request);
  const startedAt = performance.now();
  const stageStart = (): number => performance.now();
  const elapsed = (start: number): number => Number((performance.now() - start).toFixed(3));

  let start = stageStart();
  const captureAdapter = validateCaptureBundle(request.capture);
  if (!captureAdapter.ok) {
    throw new BuildPipelineFailure(
      "invalid_capture",
      "capture read profile is incompatible",
      adapterIssues(captureAdapter.issues),
    );
  }
  let dna: AnyUIDNAReadProfile | undefined;
  let effectiveUseMode = request.options.useMode;
  if (request.dna !== undefined) {
    const dnaAdapter = validateDnaProfile(request.dna, request.options.useMode);
    if (!dnaAdapter.ok) {
      throw new BuildPipelineFailure(
        "invalid_dna",
        "UI-DNA read profile is incompatible",
        adapterIssues(dnaAdapter.issues),
      );
    }
    dna = dnaAdapter.value;
    effectiveUseMode = dnaAdapter.sourceVersions.dnaUseMode ?? request.options.useMode;
  }
  const validated = validateCapture(captureAdapter.value, dna);
  if (!validated.ok) {
    throw new BuildPipelineFailure(
      "invalid_capture",
      "capture validation failed",
      pipelineIssues(validated.errors),
    );
  }
  const validateMs = elapsed(start);

  start = stageStart();
  const normalized = normalizeCapture(validated.capture);
  const normalizeMs = elapsed(start);

  start = stageStart();
  const fusedResult = fuseCapture(validated.capture, normalized, {
    includeHiddenExplanatoryNodes: request.options.includeHiddenExplanatoryNodes,
  });
  const fused = fusedResult.nodes.length > 0
    ? fusedResult.nodes
    : [documentFallback(validated.capture)];
  const fuseMs = elapsed(start);

  start = stageStart();
  const hierarchy = buildHierarchy(fused, {
    maxNodes: request.options.maxNodes,
    repeatedRegionThreshold: request.options.repeatedRegionThreshold,
  });
  const retainedCandidateIds = new Set(hierarchy.hierarchy.map((entry) => entry.candidateId));
  const boundedFused = fused.filter((node) => retainedCandidateIds.has(node.candidateId));
  const relationResult = buildRelations(boundedFused, hierarchy.hierarchy, {
    maxPersistedEdgesPerNode: request.options.maxPersistedEdgesPerNode,
  });
  const nodeIds = assignNodeIds(boundedFused, hierarchy.hierarchy);
  const remappedRegions = remapRegions(hierarchy.regions, nodeIds);
  const edges = remapEdges(relationResult.edges, nodeIds, boundedFused);
  const relationsMs = elapsed(start);

  start = stageStart();
  const baseNodes = createGraphNodes(
    boundedFused,
    hierarchy.hierarchy,
    nodeIds,
    remappedRegions.ids,
    validated.capture,
    normalized,
  );
  const projected = projectDna(baseNodes, {
    dna,
    useMode: effectiveUseMode,
    route: validated.capture.route,
  });
  if (!projected.ok) {
    throw new BuildPipelineFailure(
      "invalid_dna",
      "UI-DNA projection failed",
      adapterIssues(projected.issues),
    );
  }
  const dnaProjectionMs = elapsed(start);

  start = stageStart();
  const deterministicInputHash = sha256(canonicalize({
    capture: captureAdapter.value,
    dna,
    options: request.options,
  }));
  const warnings = buildWarnings(
    validated.capture,
    [
      ...validated.warnings,
      ...normalized.warnings,
      ...fusedResult.warnings,
      ...hierarchy.warnings,
    ],
    hierarchy.truncation.truncated,
    hierarchy.truncation.omittedNodeCount,
  );
  const metrics = buildMetrics(validated.capture, boundedFused, edges, remappedRegions.regions);
  const draft: UIGraphSnapshotDraft = {
    schemaVersion: SCHEMA_VERSION,
    build: {
      builderVersion: request.options.builderVersion,
      relationPolicyVersion: request.options.relationPolicyVersion,
      dnaProjectionVersion: request.options.dnaProjectionVersion,
      redactionPolicyVersion: request.options.redactionPolicyVersion,
      deterministicInputHash,
    },
    source: sourceMetadata(validated.capture, dna, effectiveUseMode),
    coordinateSpaces: normalized.coordinateSpaces,
    nodes: projected.nodes.map(({ elementRef: _elementRef, ...node }) => node),
    edges,
    regions: remappedRegions.regions,
    metrics,
    warnings,
  };
  if (projected.projection !== undefined) draft.dnaProjection = projected.projection;

  let snapshot;
  try {
    snapshot = sealSnapshot(draft);
  } catch (error) {
    throw new BuildPipelineFailure(
      "invalid_snapshot",
      error instanceof Error ? error.message : "snapshot sealing failed",
    );
  }
  const serializeMs = elapsed(start);
  const canonicalJsonBytes = Buffer.byteLength(canonicalize(snapshot), "utf8");
  const totalMs = Number((performance.now() - startedAt).toFixed(3));

  return {
    snapshot,
    diagnostics: {
      builtAt: new Date().toISOString(),
      timingMs: {
        validate: validateMs,
        normalize: normalizeMs,
        fuse: fuseMs,
        relations: relationsMs,
        dnaProjection: dnaProjectionMs,
        serialize: serializeMs,
        total: totalMs,
      },
      canonicalJsonBytes,
      counters: {
        source_dom_nodes: metrics.source.domNodes,
        source_accessibility_nodes: metrics.source.accessibilityNodes,
        graph_nodes: metrics.graph.nodes,
        graph_edges: metrics.graph.edges,
        graph_regions: metrics.graph.regions,
        graph_conflicts: metrics.graph.conflictCount,
        warnings: warnings.length,
        summarized_nodes: hierarchy.truncation.omittedNodeCount,
        authoritative_dna_matches: projected.projection?.authoritativeMatchCount ?? 0,
        advisory_dna_matches: projected.projection?.advisoryMatchCount ?? 0,
      },
    },
  };
}
