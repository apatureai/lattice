/**
 * Advisory visual-saliency prior (TRD §8.5 saliency ranking).
 *
 * A token-budgeted view must decide which nodes matter most; a saliency prior —
 * "where is a human's attention likely to land?" — is a better input to that
 * ranking than raw size. This is the deployable, no-neuroimaging realization of
 * that idea: a `SaliencyProvider` PORT that a UEyes-style attention model drops
 * into in production, with a deterministic heuristic baseline here.
 *
 * Saliency is strictly ADVISORY — a perception prior, never authoritative DNA.
 * It informs ordering and evidence requests; it never overrides a fact or a
 * grounded standard. The heuristic reads only the normalized geometry + role, so
 * it stays pure and deterministic (no model/network).
 */

import type { FusedNode } from "./fuse.js";

export interface SaliencyScore {
  candidateId: string;
  /** Predicted relative attention in [0,1]; advisory only. */
  saliency: number;
}

/** Injected attention model. Production wraps a UEyes-style predictor; tests stub it. */
export interface SaliencyProvider {
  score(nodes: readonly FusedNode[]): SaliencyScore[];
}

export interface SaliencyViewport {
  width: number;
  height: number;
}

/** Roles that draw disproportionate attention (headings, primary controls, media). */
const ROLE_WEIGHT: Record<string, number> = {
  heading: 1, banner: 0.9, main: 0.6, button: 0.8, link: 0.6, img: 0.7, image: 0.7,
  navigation: 0.5, search: 0.7, alert: 1, status: 0.6, dialog: 0.9,
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function viewportOf(nodes: readonly FusedNode[], provided?: SaliencyViewport): SaliencyViewport {
  if (provided !== undefined) return provided;
  let w = 1;
  let h = 1;
  for (const n of nodes) {
    const r = n.geometry?.viewportRect;
    if (r === undefined) continue;
    w = Math.max(w, r.x + r.width);
    h = Math.max(h, r.y + r.height);
  }
  return { width: w, height: h };
}

/**
 * Deterministic heuristic saliency, grounded in well-known UI attention effects:
 * elements near the TOP and horizontal CENTER, larger elements, and
 * attention-drawing ROLES score higher. A geometry-less node gets a small floor
 * (it exists but can't be spatially weighted).
 */
export function heuristicSaliency(nodes: readonly FusedNode[], viewport?: SaliencyViewport): SaliencyScore[] {
  const vp = viewportOf(nodes, viewport);
  const vpArea = Math.max(1, vp.width * vp.height);

  const scores = nodes.map((node): SaliencyScore => {
    const g = node.geometry?.viewportRect;
    // `Object.hasOwn`, not a bare index: `role.value` is untrusted capture data,
    // and a plain-object lookup walks the prototype chain — a role of
    // `constructor`/`__proto__`/`toString` would otherwise resolve to an inherited
    // member (a function/object, which `?? 0.3` does NOT catch), poisoning the
    // score with `NaN`. An unknown role falls through to the 0.3 default.
    const role = node.role?.value;
    const roleWeight = role !== undefined && Object.hasOwn(ROLE_WEIGHT, role) ? ROLE_WEIGHT[role] ?? 0.3 : 0.3;
    if (g === undefined) return { candidateId: node.candidateId, saliency: clamp01(0.1 + 0.1 * roleWeight) };

    const topness = clamp01(1 - g.y / vp.height); // higher on the page = more salient
    const centerX = g.x + g.width / 2;
    const centrality = clamp01(1 - Math.abs(centerX / vp.width - 0.5) * 2);
    const size = clamp01(Math.sqrt((g.width * g.height) / vpArea)); // sqrt so huge areas don't dominate

    const saliency = clamp01(0.35 * topness + 0.2 * centrality + 0.25 * size + 0.2 * roleWeight);
    return { candidateId: node.candidateId, saliency };
  });

  return scores.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
}

/** A `SaliencyProvider` backed by the deterministic heuristic (the default baseline). */
export const heuristicSaliencyProvider: SaliencyProvider = { score: (nodes) => heuristicSaliency(nodes) };

/** Candidate ids ranked most- to least-salient; ties broken by id for determinism. */
export function rankBySaliency(scores: readonly SaliencyScore[]): string[] {
  return [...scores]
    .sort((a, b) => b.saliency - a.saliency || a.candidateId.localeCompare(b.candidateId))
    .map((s) => s.candidateId);
}
