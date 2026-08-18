/**
 * Crop/overlay evidence requests (#15; PRD §6.5, TRD §7/§10/§11,
 * ARCHITECTURE §11; PRD §18.29). Selective pixel escalation: a view
 * RECOMMENDS crops/overlays and the consumer decides whether to fetch.
 * UI Graph never produces pixels, never holds artifact bytes, and a request
 * is not an authorization (§18.38: capability-scoped, not execution
 * authority).
 *
 * Determinism and honesty rules:
 *  - geometry comes straight from the normalized viewport rects, so the
 *    request↔viewport transform is exact by construction (the ≤2 CSS px /
 *    0.5% bar is met with zero error, asserted in tests);
 *  - a degenerate or out-of-bounds target NEVER yields a misleading crop;
 *    the affected refs are returned as typed rejections instead (TRD §16);
 *  - one padded local crop is preferred over a full screenshot; the full
 *    screenshot is the fallback when the crop would cover most of the
 *    viewport anyway;
 *  - a marked overlay always preserves the unmarked crop request for audit;
 *  - every request states WHY pixels are needed, and saliency provenance
 *    (heuristic or injected provider) is recorded.
 */

import { createHash } from "node:crypto";
import { canonicalize, compareCodeUnits } from "../canonical.js";
import type { Rect } from "../types.js";
import type { ViewSourceNode } from "./view-source.js";
import { heuristicSaliency, type SaliencyScore } from "./saliency.js";

export type EvidenceRequestKind = "crop" | "full_screenshot" | "marked_overlay";

/** Why pixels are being requested (TRD §11's deterministic signals). */
export type EvidenceRequestReason =
  | "requested_refs"
  | "small_or_dense_target"
  | "parser_only_provenance"
  | "source_disagreement"
  | "high_saliency";

export interface EvidenceRequest {
  /** Content-addressed over the request body, so same inputs, same id. */
  requestId: string;
  kind: EvidenceRequestKind;
  /** Logical artifact ref of the source screenshot; never a URL (TRD §17). */
  sourceArtifactRef: string;
  coordinateSpaceId: "viewport";
  /** Padded, viewport-clipped crop rectangle (viewport space). */
  rect: Rect;
  /** The snapshot-local candidate ids the crop covers. */
  candidateIds: string[];
  reasons: EvidenceRequestReason[];
  /** Deterministic rank: lower = fetch first. */
  priority: number;
  /** Saliency provenance: which provider produced the ranking signal. */
  saliencyProvider: string;
  /** For marked_overlay: the unmarked crop preserved for audit. */
  unmarkedRequestId?: string;
}

/** A target that must NOT be cropped: the claim is rejected, never misled. */
export interface RejectedVisualTarget {
  candidateId: string;
  reason: "degenerate_geometry" | "outside_viewport" | "missing_geometry";
}

export interface EvidenceRequestOptions {
  sourceArtifactRef: string;
  viewport: { width: number; height: number };
  /** Candidate ids the caller explicitly needs pixels for (e.g. violation refs). */
  requestedIds?: readonly string[];
  /** Padding in CSS px around the target union (default 24). */
  paddingPx?: number;
  /** Max requests emitted (default 4). */
  maxRequests?: number;
  /** Crop covering more than this fraction of the viewport falls back to full screenshot (default 0.8). */
  fullScreenshotThreshold?: number;
  /** Emit a marked overlay alongside each crop (only when a profile demonstrated benefit). */
  markedOverlay?: boolean;
  /** Externally supplied saliency (provider provenance recorded); default heuristic. */
  saliency?: { provider: string; scores: readonly SaliencyScore[] };
}

export interface EvidenceRequestPlan {
  requests: EvidenceRequest[];
  rejected: RejectedVisualTarget[];
}

const clampRect = (rect: Rect, viewport: { width: number; height: number }): Rect => {
  const x = Math.max(0, Math.min(rect.x, viewport.width));
  const y = Math.max(0, Math.min(rect.y, viewport.height));
  return {
    x,
    y,
    width: Math.max(0, Math.min(rect.x + rect.width, viewport.width) - x),
    height: Math.max(0, Math.min(rect.y + rect.height, viewport.height) - y),
  };
};

const degenerate = (rect: Rect): boolean =>
  !Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
  !Number.isFinite(rect.width) || !Number.isFinite(rect.height) ||
  rect.width <= 0 || rect.height <= 0;

function requestId(body: unknown): string {
  return `uge_${createHash("sha256").update(canonicalize(body), "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * Plan the evidence requests for a set of target nodes. Pure and
 * deterministic; emits at most `maxRequests`, ranked by saliency-informed
 * priority. Targets whose geometry cannot honestly map to the viewport are
 * REJECTED (their visual claims must not be made), never approximated.
 */
export function buildEvidenceRequests(
  nodes: readonly ViewSourceNode[],
  options: EvidenceRequestOptions,
): EvidenceRequestPlan {
  const padding = options.paddingPx ?? 24;
  const maxRequests = options.maxRequests ?? 4;
  const threshold = options.fullScreenshotThreshold ?? 0.8;
  const viewportArea = options.viewport.width * options.viewport.height;

  const byId = new Map(nodes.map((n) => [n.candidateId, n]));
  const requestedIds = options.requestedIds ?? [];
  const provider = options.saliency?.provider ?? "heuristic@ui-graph";
  const scores = new Map(
    (options.saliency?.scores ?? heuristicSaliency(nodes, { width: options.viewport.width, height: options.viewport.height }))
      .map((s) => [s.candidateId, s.saliency]),
  );

  const rejected: RejectedVisualTarget[] = [];
  const targets: Array<{ node: ViewSourceNode; rect: Rect; reasons: EvidenceRequestReason[]; saliency: number }> = [];

  for (const id of [...new Set(requestedIds)].sort()) {
    const node = byId.get(id);
    if (node === undefined || node.geometry === undefined) {
      rejected.push({ candidateId: id, reason: "missing_geometry" });
      continue;
    }
    const rect = node.geometry.viewportRect;
    if (degenerate(rect)) {
      rejected.push({ candidateId: id, reason: "degenerate_geometry" });
      continue;
    }
    const clipped = clampRect(rect, options.viewport);
    if (clipped.width === 0 || clipped.height === 0) {
      rejected.push({ candidateId: id, reason: "outside_viewport" });
      continue;
    }

    const reasons: EvidenceRequestReason[] = ["requested_refs"];
    const area = rect.width * rect.height;
    const evidence = node.evidence ?? [];
    if (area < 32 * 32) reasons.push("small_or_dense_target");
    if (evidence.length > 0 && evidence.every((claim) => claim.sourceType === "vision_parser")) {
      reasons.push("parser_only_provenance");
    }
    if (node.flags.includes("conflict") || evidence.length > 1 && node.confidence < 0.6) {
      reasons.push("source_disagreement");
    }
    const saliency = scores.get(id) ?? 0;
    if (saliency >= 0.7) reasons.push("high_saliency");
    targets.push({ node, rect: clipped, reasons, saliency });
  }

  // Deterministic priority: saliency desc, then small targets first, then id.
  targets.sort((a, b) =>
    b.saliency - a.saliency ||
    a.rect.width * a.rect.height - b.rect.width * b.rect.height ||
    compareCodeUnits(a.node.candidateId, b.node.candidateId),
  );

  const requests: EvidenceRequest[] = [];
  for (const [index, target] of targets.slice(0, maxRequests).entries()) {
    const padded = clampRect(
      {
        x: target.rect.x - padding,
        y: target.rect.y - padding,
        width: target.rect.width + padding * 2,
        height: target.rect.height + padding * 2,
      },
      options.viewport,
    );

    // Prefer one padded local crop; fall back to the full screenshot when the
    // crop would cover most of the viewport anyway.
    const coversMostOfViewport = (padded.width * padded.height) / viewportArea > threshold;
    const kind: EvidenceRequestKind = coversMostOfViewport ? "full_screenshot" : "crop";
    const rect = coversMostOfViewport
      ? { x: 0, y: 0, width: options.viewport.width, height: options.viewport.height }
      : padded;

    const body = {
      kind,
      sourceArtifactRef: options.sourceArtifactRef,
      coordinateSpaceId: "viewport" as const,
      rect,
      candidateIds: [target.node.candidateId],
      reasons: target.reasons,
      priority: index,
      saliencyProvider: provider,
    };
    const base: EvidenceRequest = { ...body, requestId: requestId(body) };
    requests.push(base);

    // Set-of-Mark overlay only on request; the unmarked crop stays for audit.
    if (options.markedOverlay === true && kind === "crop") {
      const overlayBody = { ...body, kind: "marked_overlay" as const, unmarkedRequestId: base.requestId };
      requests.push({ ...overlayBody, requestId: requestId(overlayBody) });
    }
  }

  return { requests, rejected };
}
