/**
 * Cross-snapshot lineage matcher (#13; PRD §6.2/§6.6, TRD §6.4, ADR-007).
 *
 * Probabilistic identity between two snapshots that ABSTAINS rather than
 * mis-point: a wrong stable ref is worse than a missing match (PRD §6.2). Each
 * base node is scored against the target nodes over deterministic features; a
 * node is `matched` ONLY when its best candidate clears a high threshold AND
 * leads the runner-up by a margin. Two close candidates are `ambiguous`, a weak
 * best is `abstained`, and a base with no candidate is `removed`. Never a guess.
 *
 * Embedding similarity (TRD §6.4) is an optional advisory feature; the core is
 * fully deterministic so the same pair of snapshots always yields the same match.
 */

import type { UIGraphNodeMatch } from "../api.js";
import type { LocatorHint, Rect, UIGraphNode } from "../types.js";

/** Matcher version. A feature/threshold change forks a new series. */
export const LINEAGE_MATCH_VERSION = "lineage@1";

export interface LineageThresholds {
  /** Minimum blended score for a confident match. */
  readonly high: number;
  /** Minimum lead of the best candidate over the runner-up to disambiguate. */
  readonly margin: number;
  /** Below this the best candidate is too weak to be even a maybe ⇒ the node is `removed`. */
  readonly low: number;
}

/** Calibrated against `ug-lineage`: precision-first (PRD §7.2). */
export const DEFAULT_LINEAGE_THRESHOLDS: LineageThresholds = { high: 0.7, margin: 0.1, low: 0.25 };

export interface MatchOptions {
  readonly thresholds?: Partial<LineageThresholds>;
}

/** Feature weights, summing to 1 so the blended score is in [0,1]. */
const FEATURE_WEIGHTS: Readonly<Record<string, number>> = {
  explicit_id: 0.35,
  role: 0.15,
  name: 0.2,
  geometry: 0.15,
  region: 0.1,
  kind: 0.05,
};

// --- per-feature scores (each [0,1]) ------------------------------------------

const STABLE_ID_KINDS = new Set<LocatorHint["kind"]>(["explicit_test_id", "stable_dom_id", "href_or_form_name"]);

function stableIds(node: UIGraphNode): Set<string> {
  const ids = node.locatorHints.filter((h) => STABLE_ID_KINDS.has(h.kind)).map((h) => `${h.kind}:${h.value}`);
  return new Set(ids);
}

function explicitIdScore(a: UIGraphNode, b: UIGraphNode): number {
  if (a.elementRef === b.elementRef) return 1;
  const ai = stableIds(a);
  if (ai.size === 0) return 0;
  for (const id of stableIds(b)) if (ai.has(id)) return 1;
  return 0;
}

function roleScore(a: UIGraphNode, b: UIGraphNode): number {
  const ra = a.semantics.role;
  const rb = b.semantics.role;
  if (ra === undefined && rb === undefined) return 0.5; // no signal either way
  return ra !== undefined && ra === rb ? 1 : 0;
}

function tokenize(s: string | undefined): Set<string> {
  return new Set((s ?? "").toLowerCase().split(/\s+/).filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Jaccard, but absent-on-BOTH sides is neutral (0.5), not a penalty: no signal isn't a mismatch. */
function neutralJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0.5;
  if (a.size === 0 || b.size === 0) return 0;
  return jaccard(a, b);
}

function nameScore(a: UIGraphNode, b: UIGraphNode): number {
  if (a.semantics.name !== undefined && a.semantics.name === b.semantics.name) return 1;
  return neutralJaccard(tokenize(a.semantics.name), tokenize(b.semantics.name));
}

function rectOf(node: UIGraphNode): Rect | undefined {
  return node.geometry.normalizedViewportRect ?? node.geometry.viewportRect;
}

/** Intersection-over-union of two rects; 0 when either is absent. */
function geometryScore(a: UIGraphNode, b: UIGraphNode): number {
  const ra = rectOf(a);
  const rb = rectOf(b);
  if (ra === undefined || rb === undefined) return 0;
  const ix = Math.max(0, Math.min(ra.x + ra.width, rb.x + rb.width) - Math.max(ra.x, rb.x));
  const iy = Math.max(0, Math.min(ra.y + ra.height, rb.y + rb.height) - Math.max(ra.y, rb.y));
  const inter = ix * iy;
  const union = ra.width * ra.height + rb.width * rb.height - inter;
  return union > 0 ? inter / union : 0;
}

function regionScore(a: UIGraphNode, b: UIGraphNode): number {
  return neutralJaccard(new Set(a.regionIds), new Set(b.regionIds));
}

function kindScore(a: UIGraphNode, b: UIGraphNode): number {
  return a.kind === b.kind ? 1 : 0;
}

interface ScoredFeatures {
  readonly score: number;
  readonly features: Array<{ name: string; score: number }>;
}

function scorePair(a: UIGraphNode, b: UIGraphNode): ScoredFeatures {
  const features = [
    { name: "explicit_id", score: explicitIdScore(a, b) },
    { name: "role", score: roleScore(a, b) },
    { name: "name", score: nameScore(a, b) },
    { name: "geometry", score: geometryScore(a, b) },
    { name: "region", score: regionScore(a, b) },
    { name: "kind", score: kindScore(a, b) },
  ];
  const score = features.reduce((sum, f) => sum + (FEATURE_WEIGHTS[f.name] ?? 0) * f.score, 0);
  return { score: round(score), features };
}

// --- matching -----------------------------------------------------------------

interface Ranked {
  readonly targetId: string;
  readonly scored: ScoredFeatures;
}

/**
 * Match base nodes to target nodes with abstention. Deterministic and one-to-one:
 * base nodes are resolved in descending best-score order (tie-broken by id), and
 * a claimed target cannot be reused. Classification per base:
 *   - best ≥ high AND lead over runner-up ≥ margin ⇒ `matched`
 *   - best ≥ high but lead < margin                ⇒ `ambiguous` (two close candidates)
 *   - best < high (some signal)                    ⇒ `abstained`
 *   - no target with any signal                    ⇒ `removed`
 */
export function matchNodes(
  base: readonly UIGraphNode[],
  target: readonly UIGraphNode[],
  options: MatchOptions = {},
): UIGraphNodeMatch[] {
  const thresholds = { ...DEFAULT_LINEAGE_THRESHOLDS, ...options.thresholds };

  // Rank every base's candidates once (descending score, id tie-break).
  const ranked = new Map<string, Ranked[]>();
  for (const a of base) {
    const scored = target
      .map((b) => ({ targetId: b.nodeId, scored: scorePair(a, b) }))
      .sort((x, y) => y.scored.score - x.scored.score || (x.targetId < y.targetId ? -1 : x.targetId > y.targetId ? 1 : 0));
    ranked.set(a.nodeId, scored);
  }

  // Resolve strongest-first so a confident match claims its target before a
  // weaker base can contend for it.
  const order = [...base].sort((a, b) => {
    const sa = ranked.get(a.nodeId)![0]?.scored.score ?? 0;
    const sb = ranked.get(b.nodeId)![0]?.scored.score ?? 0;
    return sb - sa || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
  });

  const claimed = new Set<string>();
  const byBase = new Map<string, UIGraphNodeMatch>();
  for (const a of order) {
    const candidates = ranked.get(a.nodeId)!.filter((c) => !claimed.has(c.targetId) && c.scored.score > 0);
    const best = candidates[0];
    // No candidate, or the best is too weak to be even a maybe ⇒ confidently gone.
    if (best === undefined || best.scored.score < thresholds.low) {
      byBase.set(a.nodeId, { baseNodeId: a.nodeId, status: "removed", score: best?.scored.score ?? 0, features: best?.scored.features ?? [] });
      continue;
    }
    const runnerUp = candidates[1]?.scored.score ?? 0;
    const lead = best.scored.score - runnerUp;

    if (best.scored.score >= thresholds.high && lead >= thresholds.margin) {
      claimed.add(best.targetId);
      byBase.set(a.nodeId, {
        baseNodeId: a.nodeId, targetNodeId: best.targetId, status: "matched",
        score: best.scored.score, features: best.scored.features,
      });
    } else if (best.scored.score >= thresholds.high) {
      // Clears confidence but two candidates are too close, so abstain from pointing.
      byBase.set(a.nodeId, { baseNodeId: a.nodeId, status: "ambiguous", score: best.scored.score, features: best.scored.features });
    } else {
      // Some signal, but below the confidence bar, so an explicit non-answer.
      byBase.set(a.nodeId, { baseNodeId: a.nodeId, status: "abstained", score: best.scored.score, features: best.scored.features });
    }
  }

  // Emit in stable base order (not resolution order) for a byte-stable result.
  return base.map((a) => byBase.get(a.nodeId)!);
}

/** Target node ids that no matched base claimed, i.e. the added nodes. */
export function addedTargetIds(target: readonly UIGraphNode[], matches: readonly UIGraphNodeMatch[]): string[] {
  const claimed = new Set(matches.filter((m) => m.status === "matched").map((m) => m.targetNodeId));
  return target.map((t) => t.nodeId).filter((id) => !claimed.has(id)).sort();
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
