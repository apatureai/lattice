/**
 * Task-focused view renderer (PRD §6.4; #41). The six consumer views are
 * `focus` (bounded graph neighborhood around refs), `summary` (regions,
 * shallow hierarchy, major affordances, page-health caveats), `actionMap`,
 * `patchContext`, `violations` and `diff`, rendered either over the
 * fusion/hierarchy/relations pipeline output or, through `queryUiGraph`, over a
 * sealed snapshot.
 *
 * §6.4's own requirements are load-bearing here: every view reports
 * truncation, omitted counts, a token estimate, and the policy/version that
 * produced it (these feed JudgeInputManifestV1's omission records, core
 * ADR-040). Rendering is pure and deterministic over the pipeline output, so
 * the same graph always yields a byte-identical view (`canonicalize` on the
 * selected sub-graph), and it is fail-closed: refs that resolve to nothing render
 * an explicit empty view carrying the unresolved refs, never a guess.
 *
 * ## views@2: the view text is a PROMPT projection, not a graph dump
 *
 * A view is what enters a model prompt, so it carries only facts a model can act
 * on: ref, kind, role, name, text, a normalized rect, visibility, retained
 * conflict markers, flags. Provenance (the full `evidence[]` chain, raw source
 * ids, frame rects, coordinate-space ids, per-fact confidences) stays in the
 * sealed snapshot, addressable by the very same ref the view emits. Under
 * views@1 the renderers canonicalized whole `FusedNode`s and the resulting
 * "compressed" view was consistently LARGER than the raw capture it summarized;
 * that was the projection being wrong, not the design. Auditability is
 * unchanged: every ref in a view resolves to a node whose evidence is intact.
 */

import { canonicalize } from "../canonical.js";
import { assertNoSensitiveTextSurvives, delimitUntrusted, sanitizeUntrustedText } from "./untrusted.js";
import type { LocatorHint, Rect, SensitivityLabel, UIDNAMatch, UIDNAProjection, UIGraphNode, UIRegion, Viewport } from "../types.js";
import { normalizeCssLength } from "./css.js";
import { addedTargetIds, matchNodes, type MatchOptions } from "./lineage.js";
import type { ViewSourceEdge, ViewSourceHierarchy, ViewSourceNode } from "./view-source.js";

export type { ViewSourceEdge, ViewSourceHierarchy, ViewSourceNode } from "./view-source.js";

/** The version stamp every rendered view carries (bump on policy change). */
export const VIEW_POLICY_VERSION = "views@2";

/** The graph a view renders from (`serializeB4`'s shape, and the query path's). */
export interface GraphView {
  readonly nodes: readonly ViewSourceNode[];
  readonly hierarchy: readonly ViewSourceHierarchy[];
  readonly regions: readonly UIRegion[];
  readonly edges: readonly ViewSourceEdge[];
}

export interface ViewBudget {
  /** Max nodes the view may include; beyond it the view truncates (never errors). */
  readonly maxNodes: number;
  /** Max edges the view may include; beyond it the view truncates (never errors). */
  readonly maxEdges?: number;
}

export interface ViewMeta {
  readonly view: "focus" | "summary" | "actionMap" | "patchContext" | "violations" | "diff";
  readonly policyVersion: typeof VIEW_POLICY_VERSION;
  /** True when the budget cut anything; the counts say exactly how much. */
  readonly truncated: boolean;
  readonly omitted: { readonly nodes: number; readonly edges: number; readonly regions: number };
  /** Chars/4 heuristic: an estimate by contract, never billing truth. */
  readonly tokenEstimate: number;
  readonly refsResolved: readonly string[];
  readonly refsUnresolved: readonly string[];
  /** Every node ref the rendered text actually carries (the view's real footprint). */
  readonly includedRefs: readonly string[];
  /** Every edge id the rendered text actually carries. */
  readonly includedEdgeIds: readonly string[];
  /** Set only on the fail-closed empty view. */
  readonly emptyReason?: string;
}

export interface RenderedView {
  readonly text: string;
  readonly meta: ViewMeta;
}

export interface FocusOptions {
  /** BFS radius over graph edges from the resolved refs. */
  readonly radius?: number;
  readonly budget?: ViewBudget;
}

const DEFAULT_RADIUS = 2;
const DEFAULT_BUDGET: ViewBudget = { maxNodes: 120 };

function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// --- The prompt projection (views@2) -----------------------------------------

/** One node as a prompt sees it. Provenance stays in the snapshot, not here. */
export interface PromptNode {
  readonly ref: string;
  readonly kind: string;
  /** Containment parent, folded in so structure costs no second array. */
  readonly parent?: string;
  readonly depth?: number;
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  /** Normalized [0,1] viewport rect, rounded to 4dp, so resolution-independent. */
  readonly rect?: Rect;
  readonly visibility?: string;
  /** Facts where sources disagreed. Conflict retention survives the projection. */
  readonly conflicts?: readonly string[];
  readonly flags?: readonly string[];
}

export interface PromptRegion {
  readonly regionId: string;
  readonly kind: string;
  readonly label?: string;
  readonly rootRef: string;
  /** Exact member count, even when `memberRefs` is capped. */
  readonly memberCount: number;
  readonly memberRefs: readonly string[];
  readonly memberRefsTruncated?: boolean;
  readonly itemCount?: number;
  readonly visibleItemCount?: number;
}

export interface PromptEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function promptRect(rect: Rect): Rect {
  return { x: round4(rect.x), y: round4(rect.y), width: round4(rect.width), height: round4(rect.height) };
}

const CONFLICTABLE = ["role", "name", "text"] as const;

/** Where a node sits in the containment tree, folded into the node itself. */
export interface NodePlacement {
  readonly parent?: string;
  readonly depth: number;
}

/**
 * Project one source node onto the lean prompt shape, sanitizing page text.
 * Structure travels WITH the node: a separate hierarchy array would repeat every
 * ref a second time for no extra information.
 */
export function promptNode(node: ViewSourceNode, placement?: NodePlacement): PromptNode {
  const conflicts = CONFLICTABLE.filter((fact) => node[fact]?.conflict === true);
  const flags = [...node.flags].sort();
  return {
    ref: node.candidateId,
    kind: node.kind,
    ...(placement !== undefined ? { depth: placement.depth } : {}),
    ...(placement?.parent !== undefined ? { parent: placement.parent } : {}),
    ...(node.role !== undefined ? { role: node.role.value } : {}),
    ...(node.name !== undefined ? { name: sanitizeUntrustedText(node.name.value) } : {}),
    ...(node.text !== undefined ? { text: sanitizeUntrustedText(node.text.value) } : {}),
    ...(node.geometry !== undefined ? { visibility: node.geometry.visibility } : {}),
    ...(node.geometry?.normalizedViewportRect !== undefined
      ? { rect: promptRect(node.geometry.normalizedViewportRect) }
      : {}),
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(flags.length > 0 ? { flags } : {}),
  };
}

/**
 * Project a region leanly. `memberCount` is always exact; `memberRefs` is
 * capped so one 200-row table cannot dominate a page summary, and the cap is
 * reported rather than silently applied.
 */
function promptRegion(region: UIRegion, maxMembers = Number.POSITIVE_INFINITY): PromptRegion {
  const members = [...region.memberNodeIds].sort(byString);
  const kept = members.slice(0, maxMembers);
  return {
    regionId: region.regionId,
    kind: region.kind,
    ...(region.label !== undefined ? { label: sanitizeUntrustedText(region.label) } : {}),
    rootRef: region.rootNodeId,
    memberCount: members.length,
    memberRefs: kept,
    ...(kept.length < members.length ? { memberRefsTruncated: true } : {}),
    ...(region.summary.itemCount !== undefined ? { itemCount: region.summary.itemCount } : {}),
    ...(region.summary.visibleItemCount !== undefined
      ? { visibleItemCount: region.summary.visibleItemCount }
      : {}),
  };
}

/** Index the containment tree so a node projection can carry its own placement. */
function placementIndex(hierarchy: readonly ViewSourceHierarchy[]): Map<string, NodePlacement> {
  return new Map(
    hierarchy.map((h) => [
      h.candidateId,
      { depth: h.depth, ...(h.parentNodeId !== undefined ? { parent: h.parentNodeId } : {}) },
    ]),
  );
}

function promptEdge(edge: ViewSourceEdge): PromptEdge {
  return { from: edge.fromNodeId, to: edge.toNodeId, kind: edge.kind };
}

/** Deterministic edge order so an edge budget always cuts the same tail. */
function sortEdges(edges: readonly ViewSourceEdge[]): ViewSourceEdge[] {
  return [...edges].sort(
    (a, b) =>
      byString(a.fromNodeId, b.fromNodeId) ||
      byString(a.toNodeId, b.toNodeId) ||
      byString(a.kind, b.kind) ||
      byString(a.edgeId, b.edgeId),
  );
}

/**
 * Render the bounded neighborhood around one or more node refs (§6.4
 * `focus`). BFS over ALL edges (hierarchy + relations, either direction) up
 * to `radius`; selection order is deterministic (distance first, then
 * candidateId) so a budget always cuts the same nodes. Unresolved refs fail
 * closed: no resolvable ref ⇒ an explicit empty view naming them.
 */
export function renderFocusView(
  graph: GraphView,
  refs: readonly string[],
  options: FocusOptions = {},
): RenderedView {
  const radius = options.radius ?? DEFAULT_RADIUS;
  const budget = options.budget ?? DEFAULT_BUDGET;
  const known = new Map(graph.nodes.map((n) => [n.candidateId, n]));
  const refsResolved = sortedIds(refs.filter((r) => known.has(r)));
  const refsUnresolved = sortedIds(refs.filter((r) => !known.has(r)));

  if (refsResolved.length === 0) {
    return {
      text: "",
      meta: {
        view: "focus",
        policyVersion: VIEW_POLICY_VERSION,
        truncated: false,
        omitted: { nodes: 0, edges: 0, regions: 0 },
        tokenEstimate: 0,
        refsResolved: [],
        refsUnresolved,
        includedRefs: [],
        includedEdgeIds: [],
        emptyReason: "no ref resolved to a node in this snapshot; refusing to guess a neighborhood",
      },
    };
  }

  // Undirected adjacency over every edge kind (contains + relations).
  const adjacency = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
  };
  for (const edge of graph.edges) {
    link(edge.fromNodeId, edge.toNodeId);
    link(edge.toNodeId, edge.fromNodeId);
  }

  // BFS with deterministic frontier order (distance, then candidateId).
  const distance = new Map<string, number>();
  for (const ref of refsResolved) distance.set(ref, 0);
  let frontier = [...refsResolved];
  for (let d = 1; d <= radius; d++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!distance.has(neighbor) && known.has(neighbor)) next.add(neighbor);
      }
    }
    const ordered = sortedIds(next);
    for (const id of ordered) distance.set(id, d);
    frontier = ordered;
    if (frontier.length === 0) break;
  }

  const reachable = [...distance.keys()].sort(
    (a, b) => distance.get(a)! - distance.get(b)! || (a < b ? -1 : a > b ? 1 : 0),
  );
  const kept = reachable.slice(0, budget.maxNodes);
  const keptSet = new Set(kept);
  const omittedNodes = reachable.length - kept.length;

  // #10/#17: fail closed on surviving sensitive text, then serialize page text
  // sanitized and inside the untrusted boundary: data, never instructions.
  assertNoSensitiveTextSurvives(graph.nodes);
  const hierarchy = graph.hierarchy.filter((h) => keptSet.has(h.candidateId));
  const placement = placementIndex(hierarchy);
  const nodes = graph.nodes
    .filter((n) => keptSet.has(n.candidateId))
    .map((n) => promptNode(n, placement.get(n.candidateId)));
  const edgesAll = graph.edges.filter(
    (e) => keptSet.has(e.fromNodeId) || keptSet.has(e.toNodeId),
  );
  const edgesInside = sortEdges(
    edgesAll.filter((e) => keptSet.has(e.fromNodeId) && keptSet.has(e.toNodeId)),
  );
  const edges = budget.maxEdges === undefined ? edgesInside : edgesInside.slice(0, budget.maxEdges);
  const regionIds = new Set(hierarchy.flatMap((h) => h.regionIds));
  const regions = graph.regions.filter((r) => regionIds.has(r.regionId));

  const text = delimitUntrusted(canonicalize({
    view: "focus",
    policyVersion: VIEW_POLICY_VERSION,
    refs: refsResolved,
    radius,
    nodes,
    regions: regions.map((r) => promptRegion(r)),
    edges: edges.map(promptEdge),
  }));
  const omittedEdges = edgesAll.length - edges.length;
  return {
    text,
    meta: {
      view: "focus",
      policyVersion: VIEW_POLICY_VERSION,
      truncated: omittedNodes > 0 || edgesInside.length > edges.length,
      omitted: { nodes: omittedNodes, edges: omittedEdges, regions: 0 },
      tokenEstimate: tokenEstimate(text),
      refsResolved,
      refsUnresolved,
      includedRefs: nodes.map((n) => n.ref),
      includedEdgeIds: edges.map((e) => e.edgeId),
    },
  };
}

export interface SummaryOptions {
  /** Max interactive affordances listed; beyond it the view truncates. */
  readonly maxAffordances?: number;
  /** Page-health caveats passed through from capture (§6.4: never dropped). */
  readonly caveats?: readonly string[];
  /** Caps the shallow outline as well; beyond it the view truncates. */
  readonly budget?: ViewBudget;
}

const DEFAULT_MAX_AFFORDANCES = 40;

/** Member refs listed per region in a page summary; the exact count is always kept. */
const SUMMARY_MAX_REGION_MEMBERS = 24;

/** Roles §6.4 treats as major affordances (perception context, not an action map). */
const AFFORDANCE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "searchbox",
]);

/**
 * Render the page summary (§6.4 `summary`): regions, the shallow hierarchy
 * (depth ≤ 2), major interactive affordances (capped, deterministic order),
 * and the capture's page-health caveats verbatim.
 */
export function renderSummaryView(
  graph: GraphView,
  options: SummaryOptions = {},
): RenderedView {
  const maxAffordances = options.maxAffordances ?? DEFAULT_MAX_AFFORDANCES;
  const caveats = options.caveats ?? [];
  const budget = options.budget ?? DEFAULT_BUDGET;

  assertNoSensitiveTextSurvives(graph.nodes);

  const affordancesAll = graph.nodes
    .filter((n) => n.role !== undefined && AFFORDANCE_ROLES.has(n.role.value))
    .map((n) => n.candidateId)
    .sort(byString);
  const affordances = affordancesAll.slice(0, maxAffordances);
  const omittedAffordances = affordancesAll.length - affordances.length;
  const affordanceSet = new Set(affordances);
  const placement = placementIndex(graph.hierarchy);
  const affordanceNodes = graph.nodes
    .filter((n) => affordanceSet.has(n.candidateId))
    .map((n) => promptNode(n, placement.get(n.candidateId)));

  // The outline is the shallow skeleton MINUS anything already listed as an
  // affordance, because a node is described once per view, never twice.
  const shallowAll = graph.hierarchy
    .filter((h) => h.depth <= 2)
    .sort((a, b) => a.depth - b.depth || byString(a.candidateId, b.candidateId));
  const shallow = shallowAll.slice(0, budget.maxNodes);
  const omittedOutline = shallowAll.length - shallow.length;
  const shallowSet = new Set(shallow.map((h) => h.candidateId));
  const outline = graph.nodes
    .filter((n) => shallowSet.has(n.candidateId) && !affordanceSet.has(n.candidateId))
    .map((n) => promptNode(n, placement.get(n.candidateId)));

  const includedRefs = sortedIds(new Set([...outline.map((n) => n.ref), ...affordances]));

  // Regions count against the budget too: a page with 30 `repeated` groups can
  // otherwise dominate a summary no matter how tightly the nodes are capped.
  // Named structure (landmarks, forms, lists, tables) outranks repeated groups,
  // then larger regions, then id. Deterministic, so a budget cuts the same tail.
  const rankedRegions = [...graph.regions].sort(
    (a, b) =>
      Number(a.kind === "repeated") - Number(b.kind === "repeated") ||
      b.memberNodeIds.length - a.memberNodeIds.length ||
      byString(a.regionId, b.regionId),
  );
  const keptRegions = rankedRegions.slice(0, budget.maxNodes);
  const omittedRegions = rankedRegions.length - keptRegions.length;

  const text = delimitUntrusted(canonicalize({
    view: "summary",
    policyVersion: VIEW_POLICY_VERSION,
    regions: keptRegions.map((r) => promptRegion(r, SUMMARY_MAX_REGION_MEMBERS)),
    outline,
    affordances: affordanceNodes,
    caveats,
  }));
  const omittedNodes = omittedAffordances + omittedOutline;
  return {
    text,
    meta: {
      view: "summary",
      policyVersion: VIEW_POLICY_VERSION,
      truncated: omittedNodes > 0 || omittedRegions > 0,
      omitted: { nodes: omittedNodes, edges: 0, regions: omittedRegions },
      tokenEstimate: tokenEstimate(text),
      refsResolved: [],
      refsUnresolved: [],
      includedRefs,
      includedEdgeIds: [],
    },
  };
}

export interface ActionMapOptions {
  /** Max interactive refs listed; beyond it the view truncates (never errors). */
  readonly budget?: ViewBudget;
  /** Snapshot the refs belong to; carried so a durable ref is (snapshotId, ref). */
  readonly snapshotId?: string;
}

/** An interactive element's perception state: only what capture actually observed. */
export interface ActionMapEntry {
  /** Snapshot-local candidate id (§6.4): the durable ref, never a raw source id or locator. */
  readonly ref: string;
  readonly role: string;
  readonly name?: string;
  /** Normalized [0,1] viewport rect, resolution-independent, so refs stay durable. */
  readonly rect: Rect;
  /** Perception-only state: visibility + retained pipeline flags. No action verbs, no handles. */
  readonly state: { readonly visibility: string; readonly clipped: boolean; readonly flags: readonly string[] };
}

/** On-screen enough to be a perceivable affordance (§6.4: "visible interactive refs"). */
const ACTIONMAP_VISIBILITIES = new Set(["visible", "clipped"]);

/**
 * Render the `actionMap` view (§6.4, TRD §10.2): visible interactive elements as
 * PERCEPTION CONTEXT ONLY (role, accessible name, normalized rect, and observed
 * state), never action commands (UI Graph is not a browser agent, PRD §5.2/§12).
 *
 * Fail-closed and durable-ref clean: an element needs an interactive role AND an
 * on-screen rect to appear (no geometry ⇒ nothing to point at, so it is omitted,
 * not guessed); only the synthetic `candidateId` is emitted as the ref, and raw
 * source ids / `capture_session` locators (which live only in `node.evidence`)
 * are never serialized. Untrusted names are carried as canonicalized string DATA,
 * not markup. Deterministic order (by ref) so a budget always cuts the same tail.
 */
export function renderActionMapView(graph: GraphView, options: ActionMapOptions = {}): RenderedView {
  const budget = options.budget ?? DEFAULT_BUDGET;

  const candidates: ActionMapEntry[] = [];
  for (const n of graph.nodes) {
    const role = n.role?.value;
    if (role === undefined || !AFFORDANCE_ROLES.has(role)) continue;
    const geom = n.geometry;
    if (geom === undefined || !ACTIONMAP_VISIBILITIES.has(geom.visibility)) continue; // no rect / off-screen ⇒ omit
    // No normalized rect ⇒ nothing honest to point at; omitted, never guessed.
    if (geom.normalizedViewportRect === undefined) continue;
    candidates.push({
      ref: n.candidateId,
      role,
      ...(n.name !== undefined ? { name: n.name.value } : {}),
      rect: geom.normalizedViewportRect,
      state: { visibility: geom.visibility, clipped: geom.clipped, flags: [...n.flags].sort() },
    });
  }
  candidates.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

  const kept = candidates.slice(0, budget.maxNodes);
  const omittedNodes = candidates.length - kept.length;

  const text = canonicalize({
    view: "actionMap",
    policyVersion: VIEW_POLICY_VERSION,
    ...(options.snapshotId !== undefined ? { snapshotId: options.snapshotId } : {}),
    perceptionOnly: true,
    actions: kept,
  });
  return {
    text,
    meta: {
      view: "actionMap",
      policyVersion: VIEW_POLICY_VERSION,
      truncated: omittedNodes > 0,
      omitted: { nodes: omittedNodes, edges: 0, regions: 0 },
      tokenEstimate: tokenEstimate(text),
      refsResolved: kept.map((e) => e.ref),
      refsUnresolved: [],
      includedRefs: kept.map((e) => e.ref),
      includedEdgeIds: [],
    },
  };
}

// --- patchContext (repair facts for a coding agent; NEVER a patch) ------------

export interface PatchContextOptions {
  /** Max ref entries; beyond it the view truncates (never errors). */
  readonly budget?: ViewBudget;
  /** Max durable selector hints listed per entry. */
  readonly maxHintsPerRef?: number;
}

/** A durable selector hint an agent can use to locate the element in source. */
export interface PatchSelectorHint {
  readonly kind: LocatorHint["kind"];
  readonly value: string;
  readonly scope: LocatorHint["scope"];
  readonly uniqueness: number;
  readonly stability: number;
  readonly confidence: number;
}

/** The canonical component family an element likely belongs to (from DNA matches, #11). */
export interface ComponentFamilyCandidate {
  readonly ref: string;
  readonly method: string;
  readonly confidence: number;
}

/** Repair facts for one element ref: observed context only, never a generated change. */
export interface PatchContextEntry {
  readonly ref: string;
  readonly role?: string;
  readonly name?: string;
  readonly rect?: Rect;
  /** Observed style/token facts (colors, type, spacing, radius). */
  readonly style?: UIGraphNode["style"];
  /** Durable selector hints (capture-session-scoped locators excluded). */
  readonly selectorHints: readonly PatchSelectorHint[];
  readonly selectorHintsTruncated: boolean;
  /** Canonical component-family candidate, if DNA projected one. Absent ⇒ none (never guessed). */
  readonly componentFamilyCandidate?: ComponentFamilyCandidate;
  /** Evidence pointers (artifact refs), never raw source ids or content. */
  readonly evidenceRefs: readonly string[];
  readonly sensitivity: readonly SensitivityLabel[];
  /** True when the element carries a withholding sensitivity label; content fields are dropped. */
  readonly redacted: boolean;
}

const DEFAULT_MAX_HINTS_PER_REF = 8;

/** Sensitivity labels whose presence withholds a node's content (includeSensitive: false). */
const SENSITIVE_WITHHOLD = new Set<SensitivityLabel>(["pii", "secret", "credential", "redacted"]);

function isWithheld(labels: readonly SensitivityLabel[]): boolean {
  return labels.some((l) => SENSITIVE_WITHHOLD.has(l));
}

function selectorHintsOf(node: UIGraphNode, max: number): { hints: PatchSelectorHint[]; truncated: boolean } {
  // Durable only: capture-session locators are ephemeral and cannot repair source.
  const durable = node.locatorHints.filter((h) => h.scope !== "capture_session");
  durable.sort(
    (a, b) => b.stability - a.stability || b.uniqueness - a.uniqueness || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
  const kept = durable.slice(0, max).map((h) => ({
    kind: h.kind,
    value: h.value,
    scope: h.scope,
    uniqueness: h.uniqueness,
    stability: h.stability,
    confidence: h.confidence,
  }));
  return { hints: kept, truncated: durable.length > kept.length };
}

function componentFamilyOf(node: UIGraphNode): ComponentFamilyCandidate | undefined {
  // The canonical family a real DNA match names (drift still identifies the family;
  // an `unknown` match names nothing). Absent when DNA projected no family (#11).
  const match = node.dnaMatches.find(
    (m) => m.category === "component_family" && m.status !== "unknown" && m.canonical !== undefined,
  );
  return match ? { ref: String(match.canonical), method: match.method, confidence: match.confidence } : undefined;
}

function evidenceRefsOf(node: UIGraphNode): string[] {
  // Evidence POINTERS only (artifactRef); raw source ids / content never leave.
  return [...new Set(node.evidence.map((e) => e.artifactRef).filter((r): r is string => r !== undefined))].sort();
}

function definedStyle(style: UIGraphNode["style"]): UIGraphNode["style"] | undefined {
  const entries = Object.entries(style).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as UIGraphNode["style"]) : undefined;
}

function patchEntry(node: UIGraphNode, maxHints: number): PatchContextEntry {
  const rect = node.geometry.normalizedViewportRect ?? node.geometry.viewportRect;
  const redacted = isWithheld(node.sensitivity);
  if (redacted) {
    // Fail-closed: structural facts only, no name/text/style/selectors/evidence.
    return {
      ref: node.elementRef,
      ...(node.semantics.role !== undefined ? { role: node.semantics.role } : {}),
      ...(rect !== undefined ? { rect } : {}),
      selectorHints: [],
      selectorHintsTruncated: false,
      evidenceRefs: [],
      sensitivity: [...node.sensitivity].sort(),
      redacted: true,
    };
  }
  const { hints, truncated } = selectorHintsOf(node, maxHints);
  const style = definedStyle(node.style);
  const family = componentFamilyOf(node);
  return {
    ref: node.elementRef,
    ...(node.semantics.role !== undefined ? { role: node.semantics.role } : {}),
    ...(node.semantics.name !== undefined ? { name: node.semantics.name } : {}),
    ...(rect !== undefined ? { rect } : {}),
    ...(style !== undefined ? { style } : {}),
    selectorHints: hints,
    selectorHintsTruncated: truncated,
    ...(family !== undefined ? { componentFamilyCandidate: family } : {}),
    evidenceRefs: evidenceRefsOf(node),
    sensitivity: [...node.sensitivity].sort(),
    redacted: false,
  };
}

/** The page context a patch applies within (route + viewport), from UIGraphSourceMetadata. */
export interface PatchContextSource {
  readonly route: string;
  readonly viewport: Viewport;
}

/**
 * Render the `patchContext` view (§12, PRD §6.3/§6.4, TRD §10.2): the repair
 * FACTS a coding agent needs to fix an element (ref, route, viewport,
 * component-family candidate, observed style/token facts, durable selector
 * hints, and evidence pointers) for one or more refs.
 *
 * It NEVER emits a generated source patch or any model-authored content: UI
 * Graph plans/perceives, it does not modify code (PRD §5.2). Requires ≥1 ref to
 * resolve, else a fail-closed empty view naming the unresolved refs. Sensitive
 * elements (pii/secret/credential/redacted) are withheld to structural facts
 * only (`includeSensitive: false`). Deterministic: same snapshot ⇒ byte-identical.
 */
export function renderPatchContextView(
  nodes: readonly UIGraphNode[],
  refs: readonly string[],
  source: PatchContextSource,
  options: PatchContextOptions = {},
): RenderedView {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const maxHints = options.maxHintsPerRef ?? DEFAULT_MAX_HINTS_PER_REF;
  const byRef = new Map(nodes.map((n) => [n.elementRef, n]));
  const refsResolved = sortedIds(refs.filter((r) => byRef.has(r)));
  const refsUnresolved = sortedIds(refs.filter((r) => !byRef.has(r)));

  if (refsResolved.length === 0) {
    return {
      text: "",
      meta: {
        view: "patchContext",
        policyVersion: VIEW_POLICY_VERSION,
        truncated: false,
        omitted: { nodes: 0, edges: 0, regions: 0 },
        tokenEstimate: 0,
        refsResolved: [],
        refsUnresolved,
        includedRefs: [],
        includedEdgeIds: [],
        emptyReason: "patchContext requires at least one resolvable ref; refusing to guess repair context",
      },
    };
  }

  const kept = refsResolved.slice(0, budget.maxNodes);
  const omittedNodes = refsResolved.length - kept.length;
  const entries = kept.map((ref) => patchEntry(byRef.get(ref)!, maxHints));

  const text = canonicalize({
    view: "patchContext",
    policyVersion: VIEW_POLICY_VERSION,
    advisory: true,
    route: source.route,
    viewport: source.viewport,
    entries,
  });
  return {
    text,
    meta: {
      view: "patchContext",
      policyVersion: VIEW_POLICY_VERSION,
      truncated: omittedNodes > 0,
      omitted: { nodes: omittedNodes, edges: 0, regions: 0 },
      tokenEstimate: tokenEstimate(text),
      refsResolved: kept,
      refsUnresolved,
      includedRefs: kept,
      includedEdgeIds: [],
    },
  };
}

// --- violations (ranked DNA drift; authoritative vs advisory) ------------------

export interface ViolationsOptions {
  /** Max violation entries across both groups; beyond it the view truncates. */
  readonly budget?: ViewBudget;
}

/** One DNA-drift finding for an element (never a canonical assignment). */
export interface ViolationEntry {
  readonly ref: string;
  readonly category: UIDNAMatch["category"];
  readonly observed?: string | number;
  readonly canonical?: string | number;
  readonly delta?: number;
  readonly method: UIDNAMatch["method"];
  readonly confidence: number;
  /** Deterministic [0,1] severity: confidence-weighted, larger scale deviation ranks higher. */
  readonly severity: number;
  /** What evidence would confirm/refute this finding (§6.4 evidence requirement). */
  readonly evidenceRequirement: string;
}

/** A drift suppressed by an approved exception, surfaced but never silently dropped. */
export interface SuppressedViolation {
  readonly ref: string;
  readonly category: UIDNAMatch["category"];
  readonly observed?: string | number;
}

function severityOf(m: UIDNAMatch): number {
  const conf = Math.max(0, Math.min(1, m.confidence));
  if (m.category === "scale" && typeof m.delta === "number" && m.canonical !== undefined) {
    const canonicalPx = normalizeCssLength(m.canonical).valueCssPx;
    const rel = canonicalPx !== null && canonicalPx > 0 ? Math.min(1, m.delta / canonicalPx) : 1;
    return Math.round(conf * (0.5 + 0.5 * rel) * 1e6) / 1e6;
  }
  return Math.round(conf * 1e6) / 1e6;
}

function evidenceRequirementFor(category: UIDNAMatch["category"]): string {
  return category === "scale"
    ? "computed length at the element confirms the off-scale value"
    : "computed style + a rendered pixel sample at the element confirm the off-palette value";
}

function violationEntry(ref: string, m: UIDNAMatch): ViolationEntry {
  return {
    ref,
    category: m.category,
    ...(m.observed !== undefined ? { observed: m.observed } : {}),
    ...(m.canonical !== undefined ? { canonical: m.canonical } : {}),
    ...(m.delta !== undefined ? { delta: m.delta } : {}),
    method: m.method,
    confidence: m.confidence,
    severity: severityOf(m),
    evidenceRequirement: evidenceRequirementFor(m.category),
  };
}

/** Deterministic rank: severity desc, then ref, category, observed for stability. */
function rankViolations(entries: ViolationEntry[]): ViolationEntry[] {
  return [...entries].sort(
    (a, b) =>
      b.severity - a.severity ||
      (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0) ||
      (a.category < b.category ? -1 : a.category > b.category ? 1 : 0) ||
      String(a.observed).localeCompare(String(b.observed)),
  );
}

/**
 * Render the `violations` view (#12, PRD §6.4, TRD §10.2): the ranked DNA drift
 * an element carries, with AUTHORITATIVE deterministic drift separated from
 * ADVISORY matches. A drift is authoritative only when the projection was
 * authoritative-capable (approved DNA in a production build) AND the match was
 * deterministic (not an embedding candidate); everything else is advisory.
 *
 * Consumes the `UIDNAMatch` facts `projectDna` (#11) stamps on each node:
 * `drift` entries are findings, `excepted` are surfaced as suppressed, `exact`/
 * `within_tolerance` are conformant and omitted. Each finding carries
 * observed/canonical/delta/ref + an evidence requirement, ranked by severity,
 * budgeted with truncation. No DNA projected ⇒ a fail-closed empty view (no
 * drift claims without an authority). Deterministic: same input ⇒ byte-identical.
 */
export function renderViolationsView(
  nodes: readonly UIGraphNode[],
  projection: UIDNAProjection | undefined,
  options: ViolationsOptions = {},
): RenderedView {
  const budget = options.budget ?? DEFAULT_BUDGET;

  if (projection === undefined) {
    return {
      text: "",
      meta: {
        view: "violations",
        policyVersion: VIEW_POLICY_VERSION,
        truncated: false,
        omitted: { nodes: 0, edges: 0, regions: 0 },
        tokenEstimate: 0,
        refsResolved: [],
        refsUnresolved: [],
        includedRefs: [],
        includedEdgeIds: [],
        emptyReason: "no UI-DNA projected onto this snapshot; refusing to claim drift without an authority",
      },
    };
  }

  const authoritativeContext = projection.state === "approved" && projection.useMode === "production";
  const authoritative: ViolationEntry[] = [];
  const advisory: ViolationEntry[] = [];
  const suppressed: SuppressedViolation[] = [];

  for (const node of nodes) {
    for (const m of node.dnaMatches) {
      if (m.status === "excepted") {
        suppressed.push({ ref: node.elementRef, category: m.category, ...(m.observed !== undefined ? { observed: m.observed } : {}) });
        continue;
      }
      if (m.status !== "drift") continue; // exact / within_tolerance are conformant
      const entry = violationEntry(node.elementRef, m);
      const isAuthoritative = authoritativeContext && m.method !== "embedding_candidate";
      (isAuthoritative ? authoritative : advisory).push(entry);
    }
  }

  const rankedAuthoritative = rankViolations(authoritative);
  const rankedAdvisory = rankViolations(advisory);
  suppressed.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0) || a.category.localeCompare(b.category));

  // Budget: authoritative findings are kept first, advisory fills the remainder.
  const keptAuthoritative = rankedAuthoritative.slice(0, budget.maxNodes);
  const remaining = Math.max(0, budget.maxNodes - keptAuthoritative.length);
  const keptAdvisory = rankedAdvisory.slice(0, remaining);
  const omittedNodes =
    rankedAuthoritative.length - keptAuthoritative.length + (rankedAdvisory.length - keptAdvisory.length);

  const refsResolved = sortedIds(new Set([...keptAuthoritative, ...keptAdvisory].map((e) => e.ref)));

  const text = canonicalize({
    view: "violations",
    policyVersion: VIEW_POLICY_VERSION,
    authoritativeContext,
    authoritative: keptAuthoritative,
    advisory: keptAdvisory,
    suppressed,
  });
  return {
    text,
    meta: {
      view: "violations",
      policyVersion: VIEW_POLICY_VERSION,
      truncated: omittedNodes > 0,
      omitted: { nodes: omittedNodes, edges: 0, regions: 0 },
      tokenEstimate: tokenEstimate(text),
      refsResolved,
      refsUnresolved: [],
      includedRefs: refsResolved,
      includedEdgeIds: [],
    },
  };
}

// --- diff (cross-snapshot change; capture instability vs product change) ------

/** The two snapshots' identity. A diff refuses to run without matching id + hash. */
export interface DiffComparison {
  readonly baseSnapshotId: string;
  readonly baseContentHash: string;
  readonly targetSnapshotId: string;
  readonly targetContentHash: string;
}

export interface DiffOptions extends MatchOptions {
  readonly budget?: ViewBudget;
  /** Normalized-rect movement at or below this is capture jitter, not a product change. */
  readonly geometryJitter?: number;
}

const DEFAULT_GEOMETRY_JITTER = 0.005;

type ChangeKind = "unchanged" | "capture_instability" | "product_change";

export interface MatchedDiffEntry {
  readonly baseRef: string;
  readonly targetRef: string;
  readonly score: number;
  readonly changeKind: ChangeKind;
  readonly changed: { readonly semantic: boolean; readonly style: boolean; readonly geometry: boolean; readonly dna: boolean };
}

function rectMoved(a: UIGraphNode, b: UIGraphNode): number {
  const ra = a.geometry.normalizedViewportRect ?? a.geometry.viewportRect;
  const rb = b.geometry.normalizedViewportRect ?? b.geometry.viewportRect;
  if (ra === undefined || rb === undefined) return 0;
  return Math.max(Math.abs(ra.x - rb.x), Math.abs(ra.y - rb.y), Math.abs(ra.width - rb.width), Math.abs(ra.height - rb.height));
}

function semanticChanged(a: UIGraphNode, b: UIGraphNode): boolean {
  return a.semantics.role !== b.semantics.role || a.semantics.name !== b.semantics.name || a.semantics.text !== b.semantics.text;
}

function styleChanged(a: UIGraphNode, b: UIGraphNode): boolean {
  return canonicalize(a.style) !== canonicalize(b.style);
}

function dnaSignature(node: UIGraphNode): string {
  return canonicalize(
    [...node.dnaMatches]
      .map((m) => ({ category: m.category, status: m.status, canonical: m.canonical ?? null }))
      .sort((x, y) => canonicalize(x).localeCompare(canonicalize(y))),
  );
}

function classifyChange(a: UIGraphNode, b: UIGraphNode, jitter: number): MatchedDiffEntry["changed"] & { changeKind: ChangeKind } {
  const semantic = semanticChanged(a, b);
  const style = styleChanged(a, b);
  const dna = dnaSignature(a) !== dnaSignature(b);
  const moved = rectMoved(a, b);
  const geometry = moved > 0;
  const changeKind: ChangeKind =
    semantic || style || dna || moved > jitter
      ? "product_change"
      : geometry
        ? "capture_instability" // only a small positional jitter, not a product change
        : "unchanged";
  return { semantic, style, geometry, dna, changeKind };
}

/**
 * Render the `diff` view (#13, TRD §10.2): matched / added / removed / ambiguous
 * nodes across two snapshots, with each matched pair's changed facts classified
 * to SEPARATE capture instability (sub-jitter positional noise) from product
 * change (semantics/style/DNA, or a real move). Runs the abstaining lineage
 * matcher (`matchNodes`) internally, so a low-confidence pair abstains, never
 * points to the wrong element.
 *
 * Fail-closed: requires a comparison snapshot id AND content hash for both
 * sides (PRD §6.6). A missing identity renders an explicit empty view, never a
 * diff against an unknown baseline. Deterministic and budgeted with truncation.
 */
export function renderDiffView(
  base: readonly UIGraphNode[],
  target: readonly UIGraphNode[],
  comparison: DiffComparison,
  options: DiffOptions = {},
): RenderedView {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const jitter = options.geometryJitter ?? DEFAULT_GEOMETRY_JITTER;

  const idOk = [comparison.baseSnapshotId, comparison.baseContentHash, comparison.targetSnapshotId, comparison.targetContentHash].every(
    (s) => typeof s === "string" && s.length > 0,
  );
  if (!idOk) {
    return {
      text: "",
      meta: {
        view: "diff",
        policyVersion: VIEW_POLICY_VERSION,
        truncated: false,
        omitted: { nodes: 0, edges: 0, regions: 0 },
        tokenEstimate: 0,
        refsResolved: [],
        refsUnresolved: [],
        includedRefs: [],
        includedEdgeIds: [],
        emptyReason: "diff requires a comparison snapshot id and content hash for both sides; refusing to diff an unknown baseline",
      },
    };
  }

  const matches = matchNodes(base, target, options);
  const baseByNode = new Map(base.map((n) => [n.nodeId, n]));
  const targetByNode = new Map(target.map((n) => [n.nodeId, n]));

  const matched: MatchedDiffEntry[] = [];
  const removed: string[] = [];
  const ambiguous: string[] = [];
  for (const m of matches) {
    const a = baseByNode.get(m.baseNodeId)!;
    if (m.status === "matched" && m.targetNodeId !== undefined) {
      const b = targetByNode.get(m.targetNodeId)!;
      const { changeKind, ...changed } = classifyChange(a, b, jitter);
      matched.push({ baseRef: a.elementRef, targetRef: b.elementRef, score: m.score, changeKind, changed });
    } else if (m.status === "removed") {
      removed.push(a.elementRef);
    } else if (m.status === "ambiguous") {
      ambiguous.push(a.elementRef);
    }
    // `abstained` is intentionally neither matched nor asserted removed. It is
    // an explicit non-answer (PRD §6.2), surfaced only in the counts below.
  }

  const added = addedTargetIds(target, matches).map((id) => targetByNode.get(id)!.elementRef).sort();
  matched.sort((x, y) => (x.baseRef < y.baseRef ? -1 : x.baseRef > y.baseRef ? 1 : 0));
  removed.sort();
  ambiguous.sort();
  const abstainedCount = matches.filter((m) => m.status === "abstained").length;

  const keptMatched = matched.slice(0, budget.maxNodes);
  const omittedNodes = matched.length - keptMatched.length;

  const text = canonicalize({
    view: "diff",
    policyVersion: VIEW_POLICY_VERSION,
    comparison,
    matched: keptMatched,
    added,
    removed,
    ambiguous,
    abstainedCount,
  });
  return {
    text,
    meta: {
      view: "diff",
      policyVersion: VIEW_POLICY_VERSION,
      truncated: omittedNodes > 0,
      omitted: { nodes: omittedNodes, edges: 0, regions: 0 },
      tokenEstimate: tokenEstimate(text),
      refsResolved: sortedIds(keptMatched.map((e) => e.baseRef)),
      refsUnresolved: [],
      includedRefs: sortedIds(new Set([...keptMatched.flatMap((e) => [e.baseRef, e.targetRef]), ...added, ...removed])),
      includedEdgeIds: [],
    },
  };
}
