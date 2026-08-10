/**
 * `queryUiGraph`: the spec-driven view dispatcher (TRD §1, §10; PRD §6.4).
 *
 * A sealed `UIGraphSnapshot` is task-neutral and complete. A `UIGraphViewSpec`
 * asks it one bounded question. This module is the seam between the two: it
 * verifies the snapshot's own identity, validates the spec, projects the sealed
 * nodes/edges/regions onto the renderer's `GraphView` shape (keyed by
 * `elementRef`, so every ref the caller passes in and every ref the view emits
 * are the same public refs), dispatches to the one renderer that answers that
 * spec, enforces the spec's budgets, and seals the result into the schema-shaped
 * `UIGraphView` envelope.
 *
 * Five rules the implementation keeps, all testable:
 *
 *  1. **Refs are verified, never guessed.** A ref that is malformed or is not a
 *     member of this exact snapshot is a typed `stale_or_foreign_ref`, resolved
 *     through `resolveElementRefInSnapshot` (full identity tuple, exact
 *     membership), never a prefix match, never a nearest neighbour.
 *  2. **`includeSensitive: false` is enforced here, not assumed upstream.**
 *     Nodes labelled pii/secret/credential/redacted lose name and text in the
 *     projection and are flagged `withheld:sensitive`; the untrusted-content
 *     boundary in `views.ts` then fails closed if anything still survives.
 *  3. **Budgets truncate, they never error.** `maxNodes`/`maxEdges` bound the
 *     render directly; `maxTextTokens` is enforced by re-rendering with a
 *     deterministically shrinking node budget and reporting the reason.
 *  4. **Identity is derived, not invented.** `specHash` is the canonical hash of
 *     the normalized spec (renderer + tokenizer profiles included) and `viewId`
 *     derives from the snapshot content hash and that spec hash, exactly the
 *     rule `schemas/README.md` states.
 *  5. **Pixels are recommended, never fetched.** Evidence requests are planned
 *     only when the caller supplies the screenshot artifact ref (a snapshot does
 *     not carry one); otherwise the view says so in `warnings` and emits none.
 *
 * Pure and deterministic: no clock, no randomness, no network. The same
 * (snapshot, spec) pair always yields a byte-identical `UIGraphView`.
 */

import { UIGraphError, type QueryUiGraphRequest } from "./api.js";
import { canonicalize, sha256 } from "./canonical.js";
import { isElementRef, resolveElementRefInSnapshot } from "./consumer-contract.js";
import { buildEvidenceRequests } from "./pipeline/evidence-request.js";
import {
  renderActionMapView,
  renderDiffView,
  renderFocusView,
  renderPatchContextView,
  renderSummaryView,
  renderViolationsView,
  type GraphView,
  type RenderedView,
  type ViewBudget,
} from "./pipeline/views.js";
import type { ViewSourceEdge, ViewSourceHierarchy, ViewSourceNode } from "./pipeline/view-source.js";
import {
  SCHEMA_VERSION,
  type EvidenceRequest,
  type SensitivityLabel,
  type UIGraphNode,
  type UIGraphSnapshot,
  type UIGraphView,
  type UIGraphViewSpec,
} from "./types.js";

/** Sensitivity labels whose page text must not reach a view (`includeSensitive: false`). */
const WITHHELD: ReadonlySet<SensitivityLabel> = new Set(["pii", "secret", "credential", "redacted"]);

const VIEW_KINDS: ReadonlySet<UIGraphViewSpec["kind"]> = new Set([
  "summary",
  "violations",
  "focus",
  "actionMap",
  "patchContext",
  "diff",
]);

/** Kinds that require at least one resolvable ref (mirrors the view JSON Schema). */
const REF_REQUIRED: ReadonlySet<UIGraphViewSpec["kind"]> = new Set(["focus", "patchContext"]);

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// --- Spec validation ---------------------------------------------------------

interface SpecIssue {
  code: string;
  message: string;
}

function positiveIntIssues(spec: UIGraphViewSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  for (const key of ["maxTextTokens", "maxNodes", "maxEdges", "maxCrops"] as const) {
    const value = spec[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      issues.push({ code: "invalid_budget", message: `${key} must be a non-negative safe integer` });
    }
  }
  return issues;
}

/**
 * Validate the spec the way the normative view schema does, before any work
 * happens. Fail-closed: a spec that cannot be answered is refused, not
 * best-efforted.
 */
function validateSpec(request: QueryUiGraphRequest): void {
  const { spec } = request;
  const issues: SpecIssue[] = [];
  if (spec === null || typeof spec !== "object") {
    throw new UIGraphError("invalid_view_spec", "view spec must be an object");
  }
  if (!VIEW_KINDS.has(spec.kind)) {
    issues.push({ code: "unknown_view_kind", message: `unknown view kind ${String(spec.kind)}` });
  }
  issues.push(...positiveIntIssues(spec));
  if (spec.includeSensitive !== false) {
    issues.push({
      code: "include_sensitive_unsupported",
      message: "includeSensitive must be false; UI Graph never renders withheld content",
    });
  }
  for (const key of ["tokenizerProfile", "rendererVersion"] as const) {
    if (typeof spec[key] !== "string" || spec[key].trim().length === 0) {
      issues.push({ code: "missing_profile", message: `${key} must be a non-empty string` });
    }
  }
  const refs = spec.refs ?? [];
  if (spec.refs !== undefined && !Array.isArray(spec.refs)) {
    issues.push({ code: "invalid_refs", message: "refs must be an array of elementRefs" });
  } else {
    for (const ref of refs) {
      if (!isElementRef(ref)) {
        issues.push({ code: "malformed_ref", message: `${String(ref)} is not a well-formed elementRef` });
      }
    }
    if (new Set(refs).size !== refs.length) {
      issues.push({ code: "duplicate_refs", message: "refs must be unique" });
    }
  }
  if (REF_REQUIRED.has(spec.kind) && refs.length === 0) {
    issues.push({ code: "refs_required", message: `${spec.kind} requires at least one ref` });
  }
  if (spec.kind === "diff") {
    if (spec.comparisonSnapshotId === undefined || spec.comparisonContentHash === undefined) {
      issues.push({
        code: "comparison_identity_required",
        message: "diff requires comparisonSnapshotId and comparisonContentHash",
      });
    }
    if (request.comparisonSnapshot === undefined) {
      issues.push({
        code: "comparison_snapshot_required",
        message: "diff requires the comparison snapshot itself, not only its identity",
      });
    } else if (
      request.comparisonSnapshot.snapshotId !== spec.comparisonSnapshotId ||
      request.comparisonSnapshot.contentHash !== spec.comparisonContentHash
    ) {
      issues.push({
        code: "comparison_identity_mismatch",
        message: "the supplied comparison snapshot does not match the identity declared in the spec",
      });
    }
  }
  if ((spec.comparisonSnapshotId === undefined) !== (spec.comparisonContentHash === undefined)) {
    issues.push({
      code: "partial_comparison_identity",
      message: "comparisonSnapshotId and comparisonContentHash must be supplied together",
    });
  }
  if (issues.length > 0) {
    throw new UIGraphError("invalid_view_spec", "UI Graph view spec is invalid", issues);
  }
}

/** Every ref must be a verified member of THIS snapshot, or the query is refused. */
function assertRefsBelong(snapshot: UIGraphSnapshot, refs: readonly string[]): void {
  const claimed = { snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash };
  for (const ref of refs) {
    const resolution = resolveElementRefInSnapshot(snapshot, claimed, ref);
    if (!resolution.ok) {
      throw new UIGraphError(
        "stale_or_foreign_ref",
        `elementRef ${ref} is not a member of snapshot ${snapshot.snapshotId} (${resolution.detail})`,
        [{ code: resolution.detail, message: `recovery: ${resolution.recovery}` }],
      );
    }
  }
}

// --- Snapshot → renderer projection ------------------------------------------

/**
 * Visibility as the sealed snapshot records it. `visibleRect` is the viewport
 * intersection the builder computed, so its absence means the element is not on
 * screen. Derived, never guessed.
 */
function visibilityOf(node: UIGraphNode): string {
  if (node.geometry.viewportRect === undefined) return "hidden";
  if (node.geometry.visibleRect === undefined) return "offscreen";
  return node.geometry.clipped ? "clipped" : "visible";
}

function fact(value: string | undefined, conflict: boolean, confidence: number) {
  return value === undefined ? undefined : { value, confidence, conflict };
}

/**
 * Project a sealed node onto the renderer's structural node shape, keyed by its
 * public `elementRef`. Withheld sensitivity drops name/text here, before any
 * renderer sees them, and records why on the node's flags.
 */
export function viewSourceNodeOf(node: UIGraphNode): ViewSourceNode {
  const withheld = node.sensitivity.some((label) => WITHHELD.has(label));
  const conflictFlags = new Set(
    node.flags.filter((f) => f.startsWith("conflict:")).map((f) => f.slice("conflict:".length)),
  );
  const flags = withheld ? [...node.flags, "withheld:sensitive"] : [...node.flags];
  const geometry =
    node.geometry.viewportRect !== undefined
      ? {
          viewportRect: node.geometry.viewportRect,
          ...(node.geometry.normalizedViewportRect !== undefined
            ? { normalizedViewportRect: node.geometry.normalizedViewportRect }
            : {}),
          visibility: visibilityOf(node),
          clipped: node.geometry.clipped,
        }
      : undefined;
  return {
    candidateId: node.elementRef,
    kind: node.kind,
    frameId: node.geometry.frameId,
    ...(geometry !== undefined ? { geometry } : {}),
    ...(fact(node.semantics.role, conflictFlags.has("role"), node.confidence) !== undefined
      ? { role: fact(node.semantics.role, conflictFlags.has("role"), node.confidence)! }
      : {}),
    ...(!withheld && fact(node.semantics.name, conflictFlags.has("name"), node.confidence) !== undefined
      ? { name: fact(node.semantics.name, conflictFlags.has("name"), node.confidence)! }
      : {}),
    ...(!withheld && fact(node.semantics.text, conflictFlags.has("text"), node.confidence) !== undefined
      ? { text: fact(node.semantics.text, conflictFlags.has("text"), node.confidence)! }
      : {}),
    flags: flags.sort(byString),
    confidence: node.confidence,
    evidence: node.evidence,
    sensitivity: node.sensitivity,
  };
}

/**
 * Re-key a sealed snapshot onto the public `elementRef` space and hand it to the
 * renderers. Node ids and edge endpoints are internal; refs are what a model
 * cites, so the whole projected graph speaks refs.
 */
export function graphViewOf(snapshot: UIGraphSnapshot): GraphView {
  const refByNodeId = new Map(snapshot.nodes.map((n) => [n.nodeId, n.elementRef]));
  const nodes = snapshot.nodes.map(viewSourceNodeOf);
  const depthOf = new Map<string, number>();
  const depth = (nodeId: string, guard = 0): number => {
    const cached = depthOf.get(nodeId);
    if (cached !== undefined) return cached;
    const node = snapshot.nodes.find((n) => n.nodeId === nodeId);
    const parent = node?.parentNodeId;
    // `guard` bounds a malformed parent chain; sealed snapshots are acyclic.
    const value = parent === undefined || guard > snapshot.nodes.length ? 0 : depth(parent, guard + 1) + 1;
    depthOf.set(nodeId, value);
    return value;
  };
  const hierarchy: ViewSourceHierarchy[] = snapshot.nodes.map((n) => ({
    candidateId: n.elementRef,
    ...(n.parentNodeId !== undefined && refByNodeId.has(n.parentNodeId)
      ? { parentNodeId: refByNodeId.get(n.parentNodeId)! }
      : {}),
    regionIds: n.regionIds,
    depth: depth(n.nodeId),
  }));
  const edges: ViewSourceEdge[] = snapshot.edges
    .filter((e) => refByNodeId.has(e.fromNodeId) && refByNodeId.has(e.toNodeId))
    .map((e) => ({
      edgeId: e.edgeId,
      fromNodeId: refByNodeId.get(e.fromNodeId)!,
      toNodeId: refByNodeId.get(e.toNodeId)!,
      kind: e.kind,
    }));
  const regions = snapshot.regions.map((r) => ({
    ...r,
    rootNodeId: refByNodeId.get(r.rootNodeId) ?? r.rootNodeId,
    memberNodeIds: r.memberNodeIds.map((id) => refByNodeId.get(id) ?? id),
  }));
  return { nodes, hierarchy, regions, edges };
}

// --- Dispatch ----------------------------------------------------------------

/** Page-health facts §6.4 requires a summary to carry verbatim. */
function caveatsOf(snapshot: UIGraphSnapshot): string[] {
  return snapshot.warnings.map((w) => `${w.severity}: ${w.code} — ${w.message}`).sort(byString);
}

function renderFor(
  request: QueryUiGraphRequest,
  graph: GraphView,
  budget: ViewBudget,
): RenderedView {
  const { snapshot, spec } = request;
  const refs = spec.refs ?? [];
  switch (spec.kind) {
    case "focus":
      return renderFocusView(graph, refs, { budget });
    case "summary":
      return renderSummaryView(graph, {
        budget,
        maxAffordances: budget.maxNodes,
        caveats: caveatsOf(snapshot),
      });
    case "actionMap":
      return renderActionMapView(graph, { budget, snapshotId: snapshot.snapshotId });
    case "patchContext":
      return renderPatchContextView(
        snapshot.nodes,
        refs,
        { route: snapshot.source.route, viewport: snapshot.source.viewport },
        { budget },
      );
    case "violations":
      return renderViolationsView(snapshot.nodes, snapshot.dnaProjection, { budget });
    case "diff": {
      const target = request.comparisonSnapshot!;
      return renderDiffView(
        snapshot.nodes,
        target.nodes,
        {
          baseSnapshotId: snapshot.snapshotId,
          baseContentHash: snapshot.contentHash,
          targetSnapshotId: target.snapshotId,
          targetContentHash: target.contentHash,
        },
        { budget },
      );
    }
  }
}

/**
 * Render, then shrink until the text-token budget is met. The node budget is
 * halved deterministically (never randomly, never adaptively on content), so the
 * same spec always converges on the same view; if even a single node overruns,
 * the view is returned with the overrun declared rather than thrown.
 */
function renderWithinTokenBudget(
  request: QueryUiGraphRequest,
  graph: GraphView,
): { rendered: RenderedView; reasons: string[] } {
  const { spec } = request;
  const reasons: string[] = [];
  let maxNodes = spec.maxNodes;
  let rendered = renderFor(request, graph, { maxNodes, maxEdges: spec.maxEdges });
  while (rendered.meta.tokenEstimate > spec.maxTextTokens && maxNodes > 1) {
    maxNodes = Math.max(1, Math.floor(maxNodes / 2));
    rendered = renderFor(request, graph, { maxNodes, maxEdges: spec.maxEdges });
  }
  if (maxNodes < spec.maxNodes) {
    reasons.push(`text_token_budget: node budget reduced ${spec.maxNodes} → ${maxNodes}`);
  }
  if (rendered.meta.tokenEstimate > spec.maxTextTokens) {
    reasons.push(
      `text_token_budget_exceeded: ${rendered.meta.tokenEstimate} > ${spec.maxTextTokens} at the minimum node budget`,
    );
  }
  return { rendered, reasons };
}

// --- Evidence requests --------------------------------------------------------

/** Convert a planned crop into the schema-shaped `EvidenceRequest` a view carries. */
function evidenceRequestsFor(
  request: QueryUiGraphRequest,
  graph: GraphView,
  includedRefs: readonly string[],
): { requests: EvidenceRequest[]; warnings: string[] } {
  const { spec, snapshot, screenshotArtifactRef } = request;
  if (spec.maxCrops === 0) return { requests: [], warnings: [] };
  if (screenshotArtifactRef === undefined) {
    return {
      requests: [],
      warnings: [
        "no screenshotArtifactRef supplied; a sealed snapshot carries no screenshot pointer, so no evidence requests were planned",
      ],
    };
  }
  const targets = spec.refs !== undefined && spec.refs.length > 0 ? spec.refs : includedRefs;
  const plan = buildEvidenceRequests(graph.nodes, {
    sourceArtifactRef: screenshotArtifactRef,
    viewport: { width: snapshot.source.viewport.widthCssPx, height: snapshot.source.viewport.heightCssPx },
    requestedIds: targets,
    maxRequests: spec.maxCrops,
  });
  const requests = plan.requests.map((r): EvidenceRequest => ({
    requestId: r.requestId,
    kind: r.kind,
    sourceArtifactRef: r.sourceArtifactRef,
    coordinateSpaceId: r.coordinateSpaceId,
    ...(r.kind === "full_screenshot" ? {} : { rect: r.rect }),
    elementRefs: [...r.candidateIds].sort(byString),
    reason: r.reasons.join(","),
    priority: r.priority,
  }));
  const warnings = plan.rejected
    .map((r) => `evidence request refused for ${r.candidateId}: ${r.reason}`)
    .sort(byString);
  return { requests, warnings };
}

// --- Identity -----------------------------------------------------------------

/** Canonical spec projection: identity covers every field that changes the output. */
function normalizeSpec(spec: UIGraphViewSpec): Record<string, unknown> {
  return {
    kind: spec.kind,
    refs: [...(spec.refs ?? [])].sort(byString),
    ...(spec.task !== undefined ? { task: spec.task } : {}),
    ...(spec.comparisonSnapshotId !== undefined ? { comparisonSnapshotId: spec.comparisonSnapshotId } : {}),
    ...(spec.comparisonContentHash !== undefined ? { comparisonContentHash: spec.comparisonContentHash } : {}),
    maxTextTokens: spec.maxTextTokens,
    maxNodes: spec.maxNodes,
    maxEdges: spec.maxEdges,
    maxCrops: spec.maxCrops,
    includeSensitive: spec.includeSensitive,
    tokenizerProfile: spec.tokenizerProfile,
    ...(spec.visualTokenProfile !== undefined ? { visualTokenProfile: spec.visualTokenProfile } : {}),
    rendererVersion: spec.rendererVersion,
  };
}

// --- Entry point ---------------------------------------------------------------

/** Execute a view query against a sealed snapshot. See the module docblock. */
export function executeQuery(request: QueryUiGraphRequest): UIGraphView {
  const { snapshot, spec } = request;
  if (snapshot === null || typeof snapshot !== "object" || !Array.isArray(snapshot.nodes)) {
    throw new UIGraphError("invalid_snapshot", "queryUiGraph requires a sealed UIGraphSnapshot");
  }
  validateSpec(request);
  assertRefsBelong(snapshot, spec.refs ?? []);

  const graph = graphViewOf(snapshot);
  const { rendered, reasons } = renderWithinTokenBudget(request, graph);

  const nodeIdByRef = new Map(snapshot.nodes.map((n) => [n.elementRef, n.nodeId]));
  const includedNodeIds = [...new Set(rendered.meta.includedRefs)]
    .map((ref) => nodeIdByRef.get(ref))
    .filter((id): id is string => id !== undefined)
    .sort(byString);
  const includedEdgeIds = [...new Set(rendered.meta.includedEdgeIds)].sort(byString);

  const evidence = evidenceRequestsFor(request, graph, rendered.meta.includedRefs);

  const warnings = [
    ...(rendered.meta.emptyReason !== undefined ? [rendered.meta.emptyReason] : []),
    ...evidence.warnings,
  ];

  const specHash = sha256(canonicalize(normalizeSpec(spec)));
  const viewId = `ugv_1_${sha256(canonicalize({
    snapshotContentHash: snapshot.contentHash,
    specHash,
  })).slice("sha256:".length, "sha256:".length + 32)}`;

  return {
    schemaVersion: SCHEMA_VERSION,
    snapshotId: snapshot.snapshotId,
    snapshotContentHash: snapshot.contentHash,
    viewId,
    specHash,
    spec,
    text: rendered.text,
    includedNodeIds,
    includedEdgeIds,
    evidenceRequests: evidence.requests,
    budget: {
      estimatedTextTokens: rendered.meta.tokenEstimate,
      // UI Graph never embeds pixels; a crop is a recommendation the caller may
      // decline, so a view's own visual-token cost is zero by construction.
      estimatedVisualTokens: 0,
      serializedBytes: Buffer.byteLength(rendered.text, "utf8"),
      includedNodes: includedNodeIds.length,
      includedEdges: includedEdgeIds.length,
      includedCrops: evidence.requests.length,
    },
    truncation: {
      truncated: rendered.meta.truncated || reasons.length > 0,
      reasons: [
        ...reasons,
        ...(rendered.meta.omitted.nodes > 0 ? [`node_budget: ${rendered.meta.omitted.nodes} nodes omitted`] : []),
        ...(rendered.meta.omitted.edges > 0 ? [`edge_budget: ${rendered.meta.omitted.edges} edges omitted`] : []),
        ...(rendered.meta.omitted.regions > 0
          ? [`region_budget: ${rendered.meta.omitted.regions} regions omitted`]
          : []),
      ],
      omittedNodeCount: rendered.meta.omitted.nodes,
      omittedEdgeCount: rendered.meta.omitted.edges,
    },
    warnings,
  };
}
