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
import type { Rect, UIGraphEdge, UIRegion } from "../types.js";
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
  readonly view: "focus" | "summary" | "actionMap";
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
