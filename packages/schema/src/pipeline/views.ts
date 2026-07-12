/**
 * Task-focused view renderer (PRD §6.4; #41). The first two consumer views —
 * `focus` (bounded graph neighborhood around refs) and `summary` (regions,
 * shallow hierarchy, major affordances, page-health caveats) — over the
 * fusion/hierarchy/relations pipeline output.
 *
 * §6.4's own requirements are load-bearing here: every view reports
 * truncation, omitted counts, a token estimate, and the policy/version that
 * produced it (these feed JudgeInputManifestV1's omission records, core
 * ADR-040). Rendering is pure and deterministic over the pipeline output —
 * the same graph always yields a byte-identical view (`canonicalize` on the
 * selected sub-graph) — and fail-closed: refs that resolve to nothing render
 * an explicit empty view carrying the unresolved refs, never a guess.
 */

import { canonicalize } from "../canonical.js";
import type { LocatorHint, Rect, SensitivityLabel, UIGraphEdge, UIGraphNode, UIRegion, Viewport } from "../types.js";
import type { FusedNode } from "./fuse.js";
import type { NodeHierarchy } from "./hierarchy.js";

/** The version stamp every rendered view carries (bump on policy change). */
export const VIEW_POLICY_VERSION = "views@1";

/** The pipeline output a view renders from (serializeB4's exact shape). */
export interface GraphView {
  readonly nodes: readonly FusedNode[];
  readonly hierarchy: readonly NodeHierarchy[];
  readonly regions: readonly UIRegion[];
  readonly edges: readonly UIGraphEdge[];
}

export interface ViewBudget {
  /** Max nodes the view may include; beyond it the view truncates (never errors). */
  readonly maxNodes: number;
}

export interface ViewMeta {
  readonly view: "focus" | "summary" | "actionMap" | "patchContext";
  readonly policyVersion: typeof VIEW_POLICY_VERSION;
  /** True when the budget cut anything; the counts say exactly how much. */
  readonly truncated: boolean;
  readonly omitted: { readonly nodes: number; readonly edges: number };
  /** Chars/4 heuristic — an estimate by contract, never billing truth. */
  readonly tokenEstimate: number;
  readonly refsResolved: readonly string[];
  readonly refsUnresolved: readonly string[];
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
        omitted: { nodes: 0, edges: 0 },
        tokenEstimate: 0,
        refsResolved: [],
        refsUnresolved,
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

  const nodes = graph.nodes.filter((n) => keptSet.has(n.candidateId));
  const hierarchy = graph.hierarchy.filter((h) => keptSet.has(h.candidateId));
  const edgesAll = graph.edges.filter(
    (e) => keptSet.has(e.fromNodeId) || keptSet.has(e.toNodeId),
  );
  const edges = edgesAll.filter(
    (e) => keptSet.has(e.fromNodeId) && keptSet.has(e.toNodeId),
  );
  const regionIds = new Set(hierarchy.flatMap((h) => h.regionIds));
  const regions = graph.regions.filter((r) => regionIds.has(r.regionId));

  const text = canonicalize({
    view: "focus",
    policyVersion: VIEW_POLICY_VERSION,
    refs: refsResolved,
    radius,
    nodes,
    hierarchy,
    regions,
    edges,
  });
  return {
    text,
    meta: {
      view: "focus",
      policyVersion: VIEW_POLICY_VERSION,
      truncated: omittedNodes > 0,
      omitted: { nodes: omittedNodes, edges: edgesAll.length - edges.length },
      tokenEstimate: tokenEstimate(text),
      refsResolved,
      refsUnresolved,
    },
  };
}

export interface SummaryOptions {
  /** Max interactive affordances listed; beyond it the view truncates. */
  readonly maxAffordances?: number;
  /** Page-health caveats passed through from capture (§6.4: never dropped). */
  readonly caveats?: readonly string[];
}

const DEFAULT_MAX_AFFORDANCES = 40;

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

  const shallow = graph.hierarchy.filter((h) => h.depth <= 2);
  const shallowSet = new Set(shallow.map((h) => h.candidateId));
  const outline = graph.nodes.filter((n) => shallowSet.has(n.candidateId));

  const affordancesAll = graph.nodes
    .filter((n) => n.role !== undefined && AFFORDANCE_ROLES.has(n.role.value))
    .map((n) => n.candidateId)
    .sort();
  const affordances = affordancesAll.slice(0, maxAffordances);
  const omittedAffordances = affordancesAll.length - affordances.length;
  const affordanceSet = new Set(affordances);
  const affordanceNodes = graph.nodes.filter((n) => affordanceSet.has(n.candidateId));

  const text = canonicalize({
    view: "summary",
    policyVersion: VIEW_POLICY_VERSION,
    regions: graph.regions,
    outline,
    hierarchy: shallow,
    affordances: affordanceNodes,
    caveats,
  });
  return {
    text,
    meta: {
      view: "summary",
      policyVersion: VIEW_POLICY_VERSION,
      truncated: omittedAffordances > 0,
      omitted: { nodes: omittedAffordances, edges: 0 },
      tokenEstimate: tokenEstimate(text),
      refsResolved: [],
      refsUnresolved: [],
    },
  };
}

export interface ActionMapOptions {
  /** Max interactive refs listed; beyond it the view truncates (never errors). */
  readonly budget?: ViewBudget;
  /** Snapshot the refs belong to; carried so a durable ref is (snapshotId, ref). */
  readonly snapshotId?: string;
}

/** An interactive element's perception state — only what capture actually observed. */
export interface ActionMapEntry {
  /** Snapshot-local candidate id (§6.4): the durable ref, never a raw source id or locator. */
  readonly ref: string;
  readonly role: string;
  readonly name?: string;
  /** Normalized [0,1] viewport rect — resolution-independent, so refs stay durable. */
  readonly rect: Rect;
  /** Perception-only state: visibility + retained pipeline flags. No action verbs, no handles. */
  readonly state: { readonly visibility: string; readonly clipped: boolean; readonly flags: readonly string[] };
}

/** On-screen enough to be a perceivable affordance (§6.4: "visible interactive refs"). */
const ACTIONMAP_VISIBILITIES = new Set(["visible", "clipped"]);

/**
 * Render the `actionMap` view (§6.4, TRD §10.2): visible interactive elements as
 * PERCEPTION CONTEXT ONLY — role, accessible name, normalized rect, and observed
 * state — never action commands (UI Graph is not a browser agent, PRD §5.2/§12).
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
      omitted: { nodes: omittedNodes, edges: 0 },
      tokenEstimate: tokenEstimate(text),
      refsResolved: kept.map((e) => e.ref),
      refsUnresolved: [],
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

/** Repair facts for one element ref — observed context only, never a generated change. */
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
 * FACTS a coding agent needs to fix an element — ref, route, viewport,
 * component-family candidate, observed style/token facts, durable selector
 * hints, and evidence pointers — for one or more refs.
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
        omitted: { nodes: 0, edges: 0 },
        tokenEstimate: 0,
        refsResolved: [],
        refsUnresolved,
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
      omitted: { nodes: omittedNodes, edges: 0 },
      tokenEstimate: tokenEstimate(text),
      refsResolved: kept,
      refsUnresolved,
    },
  };
}
