/**
 * #15: crop/overlay evidence requests — honest geometry (a target that cannot
 * map to the viewport is rejected, never approximated), one padded local crop
 * preferred over full screenshot, deterministic ranking with saliency
 * provenance, overlay preserving the unmarked crop for audit, and a stated
 * reason on every request.
 */
import { describe, expect, it } from "vitest";
import { buildEvidenceRequests } from "../src/index.js";
import type { FusedNode } from "../src/pipeline/fuse.js";

const geometry = (rect: { x: number; y: number; width: number; height: number }) => ({
  frameId: "frame_0",
  frameRect: rect,
  documentRect: rect,
  viewportRect: rect,
  normalizedViewportRect: rect,
  coordinateSpaceId: "viewport",
  visibility: "visible" as const,
  clipped: false,
});

const node = (id: string, rect: { x: number; y: number; width: number; height: number }, extra: Partial<FusedNode> = {}): FusedNode => ({
  candidateId: id,
  kind: "element",
  frameId: "frame_0",
  geometry: geometry(rect),
  evidence: [{ sourceType: "layout", sourceId: "document_0", coordinateSpaceId: "viewport", confidence: 1, claims: ["geometry"] }],
  flags: [],
  confidence: 0.9,
  ...extra,
} as FusedNode);

const viewport = { width: 1280, height: 800 };
const opts = { sourceArtifactRef: "uiart:shot/1", viewport };

describe("evidence requests (#15)", () => {
  it("emits one padded, viewport-clipped crop per requested target with exact geometry (≤2px bar met at 0)", () => {
    const target = node("c_btn", { x: 100, y: 200, width: 120, height: 40 });
    const { requests, rejected } = buildEvidenceRequests([target], { ...opts, requestedIds: ["c_btn"] });
    expect(rejected).toEqual([]);
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.kind).toBe("crop");
    // Exact padding math: source rect ± 24, no transform error at all.
    expect(req.rect).toEqual({ x: 76, y: 176, width: 168, height: 88 });
    expect(req.coordinateSpaceId).toBe("viewport");
    expect(req.reasons).toContain("requested_refs"); // every request states why
    expect(req.saliencyProvider).toBe("heuristic@ui-graph");
    expect(req.requestId).toMatch(/^uge_[0-9a-f]{16}$/);
  });

  it("clips padding at the viewport edge instead of emitting out-of-bounds rects", () => {
    const edge = node("c_edge", { x: 4, y: 4, width: 40, height: 20 });
    const { requests } = buildEvidenceRequests([edge], { ...opts, requestedIds: ["c_edge"] });
    expect(requests[0]!.rect.x).toBe(0);
    expect(requests[0]!.rect.y).toBe(0);
  });

  it("never emits a misleading crop: degenerate, missing, and off-viewport targets are typed rejections", () => {
    const bad = node("c_bad", { x: 10, y: 10, width: 0, height: 40 });
    const off = node("c_off", { x: 5000, y: 5000, width: 40, height: 40 });
    const noGeo = { ...node("c_nogeo", { x: 0, y: 0, width: 1, height: 1 }) } as FusedNode & { geometry?: undefined };
    delete (noGeo as { geometry?: unknown }).geometry;
    const { requests, rejected } = buildEvidenceRequests([bad, off, noGeo], {
      ...opts,
      requestedIds: ["c_bad", "c_off", "c_nogeo", "c_ghost"],
    });
    expect(requests).toEqual([]);
    expect(rejected).toEqual([
      { candidateId: "c_bad", reason: "degenerate_geometry" },
      { candidateId: "c_ghost", reason: "missing_geometry" },
      { candidateId: "c_nogeo", reason: "missing_geometry" },
      { candidateId: "c_off", reason: "outside_viewport" },
    ]);
  });

  it("falls back to full_screenshot when the padded crop covers most of the viewport", () => {
    const huge = node("c_hero", { x: 10, y: 10, width: 1200, height: 700 });
    const { requests } = buildEvidenceRequests([huge], { ...opts, requestedIds: ["c_hero"] });
    expect(requests[0]!.kind).toBe("full_screenshot");
    expect(requests[0]!.rect).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });

  it("a marked overlay always preserves the unmarked crop request for audit", () => {
    const target = node("c_btn", { x: 100, y: 200, width: 120, height: 40 });
    const { requests } = buildEvidenceRequests([target], { ...opts, requestedIds: ["c_btn"], markedOverlay: true });
    expect(requests.map((r) => r.kind)).toEqual(["crop", "marked_overlay"]);
    expect(requests[1]!.unmarkedRequestId).toBe(requests[0]!.requestId);
  });

  it("ranking is deterministic and saliency provenance is recorded for injected providers", () => {
    const a = node("c_a", { x: 0, y: 0, width: 200, height: 100 });
    const b = node("c_b", { x: 400, y: 400, width: 20, height: 20 });
    const plan = buildEvidenceRequests([a, b], {
      ...opts,
      requestedIds: ["c_a", "c_b"],
      saliency: { provider: "ueyes@2", scores: [{ candidateId: "c_a", saliency: 0.2 }, { candidateId: "c_b", saliency: 0.9 }] },
    });
    expect(plan.requests.map((r) => r.candidateIds[0])).toEqual(["c_b", "c_a"]); // saliency order
    expect(plan.requests[0]!.priority).toBe(0);
    expect(plan.requests[0]!.saliencyProvider).toBe("ueyes@2");
    expect(plan.requests[0]!.reasons).toContain("high_saliency");
    expect(plan.requests[0]!.reasons).toContain("small_or_dense_target");
    // Same inputs → identical plan (content-addressed ids included).
    expect(buildEvidenceRequests([a, b], { ...opts, requestedIds: ["c_a", "c_b"], saliency: { provider: "ueyes@2", scores: [{ candidateId: "c_a", saliency: 0.2 }, { candidateId: "c_b", saliency: 0.9 }] } })).toEqual(plan);
  });

  it("enforces the request budget", () => {
    const nodes = Array.from({ length: 6 }, (_, i) => node(`c_${i}`, { x: i * 50, y: 100, width: 40, height: 20 }));
    const { requests } = buildEvidenceRequests(nodes, { ...opts, requestedIds: nodes.map((n) => n.candidateId), maxRequests: 3 });
    expect(requests).toHaveLength(3);
  });
});
