/**
 * Pipeline stage 3 — candidate generation + evidence fusion (TRD §8.3–§8.4,
 * §5.3–§5.4; ARCHITECTURE §7; PRD §6.1).
 *
 * Turns normalized multi-source observations into fused node facts WITHOUT
 * letting any source silently overwrite another. Two acceptance invariants drive
 * the design:
 *
 *  - **Conflict retention.** When sources disagree on a fact (e.g. the AX role
 *    vs the DOM role), both values are kept as coexisting `EvidenceClaim`s, the
 *    fact is flagged, its confidence is lowered, and the node confidence is a
 *    conservative aggregate. Nothing is silently dropped.
 *  - **No global source ranking.** Competence is decided PER FACT (AX is more
 *    competent for role/name, text runs/OCR for text), never globally. Raw
 *    source ids appear only inside evidence claims — never as a node's external
 *    id (TRD §5.3); fused nodes carry a synthetic, snapshot-local candidate id.
 *
 * Deterministic: byte-identical input yields byte-identical output. No model,
 * browser, or network is touched.
 */

import type { Rect, EvidenceClaim } from "../types.js";
import type {
  CaptureBundleReadProfile,
  CaptureAccessibilityNode,
  CaptureDomLayoutNode,
  CaptureTextRun,
  DerivedObservation,
} from "../readprofile.js";
import type { NormalizedCapture, NormalizedGeometry, NormalizedNode } from "./normalize.js";
import { compose, IDENTITY, transformRect, translateRect, type Affine } from "./geometry.js";
import { warn, type PipelineIssue } from "./errors.js";

export type FusedKind = "dom" | "ax_only" | "text" | "visual";

export interface FusedFact<T> {
  readonly value: T;
  readonly confidence: number;
  readonly conflict: boolean;
}

export interface FusedNode {
  /** Synthetic, snapshot-local id. Raw source ids never appear here (TRD §5.3). */
  readonly candidateId: string;
  readonly kind: FusedKind;
  readonly frameId: string;
  readonly geometry?: NormalizedGeometry;
  readonly role?: FusedFact<string>;
  readonly name?: FusedFact<string>;
  readonly text?: FusedFact<string>;
  /** Every contributing claim; the only place raw source ids live. */
  readonly evidence: EvidenceClaim[];
  readonly flags: string[];
  readonly confidence: number;
}

export interface FusionResult {
  readonly nodes: FusedNode[];
  readonly warnings: PipelineIssue[];
}

export interface FuseOptions {
  /** Keep hidden DOM nodes as explanatory candidates (default false). */
  includeHiddenExplanatoryNodes?: boolean;
  /** Minimum IoU for a visual/OCR candidate to fuse into a structured node. */
  iouThreshold?: number;
}

// --- Source confidence + per-fact competence (ARCHITECTURE §7) -----------

const BASE_CONFIDENCE: Record<string, number> = {
  dom: 0.9,
  layout: 0.9,
  accessibility: 0.85,
  text_run: 0.8,
  vision_parser: 0.6,
  ocr: 0.6,
};

type Fact = "role" | "name" | "text";

/** Per-fact competence — NOT a global ranking. Higher wins the fact's value. */
function competence(sourceType: string, fact: Fact): number {
  if (fact === "role") return sourceType === "accessibility" ? 3 : sourceType === "dom" ? 2 : 1;
  if (fact === "name") return sourceType === "accessibility" ? 3 : sourceType === "text_run" ? 2 : 1;
  // text
  return sourceType === "text_run" ? 3 : sourceType === "ocr" ? 2 : sourceType === "accessibility" ? 1 : 0;
}

// --- Geometry overlap ---------------------------------------------------

function iou(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

// --- Internal mutable candidate -----------------------------------------

interface FactClaim {
  sourceType: string;
  value: string;
  confidence: number;
}

interface Candidate {
  kind: FusedKind;
  frameId: string;
  geometry?: NormalizedGeometry;
  evidence: EvidenceClaim[];
  flags: string[];
  roleClaims: FactClaim[];
  nameClaims: FactClaim[];
  textClaims: FactClaim[];
}

function addClaim(
  cand: Candidate,
  sourceType: EvidenceClaim["sourceType"],
  sourceId: string,
  claims: string[],
  confidence: number,
  extra: Partial<EvidenceClaim> = {},
): void {
  cand.evidence.push({ sourceType, sourceId, confidence, claims, ...extra });
}

/** Resolve a fact from its competing claims: most-competent value wins; all are kept. */
function resolveFact(fact: Fact, claims: FactClaim[]): FusedFact<string> | undefined {
  const present = claims.filter((c) => c.value.trim().length > 0);
  if (present.length === 0) return undefined;
  const ranked = [...present].sort(
    (a, b) =>
      competence(b.sourceType, fact) - competence(a.sourceType, fact) ||
      b.confidence - a.confidence ||
      a.value.localeCompare(b.value),
  );
  const winner = ranked[0]!;
  const distinct = new Set(present.map((c) => c.value));
  const conflict = distinct.size > 1;
  const confidence = conflict ? winner.confidence * 0.5 : winner.confidence;
  return { value: winner.value, confidence, conflict };
}

// --- Candidate generation + fusion --------------------------------------

export function fuseCapture(
  capture: CaptureBundleReadProfile,
  normalized: NormalizedCapture,
  options: FuseOptions = {},
): FusionResult {
  const includeHidden = options.includeHiddenExplanatoryNodes ?? false;
  const iouThreshold = options.iouThreshold ?? 0.5;
  const warnings: PipelineIssue[] = [];

  const normalizedById = new Map<string, NormalizedNode>(normalized.nodes.map((n) => [n.sourceId, n]));
  const domNodes: CaptureDomLayoutNode[] = [];
  const axNodes: CaptureAccessibilityNode[] = [];
  const textRuns: CaptureTextRun[] = [];
  for (const doc of capture.documents) {
    domNodes.push(...doc.domLayoutNodes);
    axNodes.push(...doc.accessibilityNodes);
    textRuns.push(...(doc.textRuns ?? []));
  }

  // Anchor candidates by DOM source id; AX/text/visual fuse into or beside them.
  const byDom = new Map<string, Candidate>();
  const extras: Candidate[] = [];

  // (1) Structured candidates from visible DOM layout nodes.
  for (const dom of domNodes) {
    const geom = normalizedById.get(dom.sourceId)?.geometry;
    const hidden = geom?.visibility === "hidden" || dom.visible === false;
    if (hidden && !includeHidden) continue;
    const cand: Candidate = {
      kind: "dom",
      frameId: dom.frameId,
      geometry: geom,
      evidence: [],
      flags: hidden ? ["hidden_explanatory"] : [],
      roleClaims: [],
      nameClaims: [],
      textClaims: [],
    };
    const claims: string[] = [];
    if (dom.role !== undefined) {
      claims.push(`role=${dom.role}`);
      cand.roleClaims.push({ sourceType: "dom", value: dom.role, confidence: BASE_CONFIDENCE.dom! });
    }
    if (dom.tag !== undefined) claims.push(`tag=${dom.tag}`);
    addClaim(cand, "dom", dom.sourceId, claims, BASE_CONFIDENCE.dom!, geom ? { coordinateSpaceId: geom.coordinateSpaceId } : {});
    byDom.set(dom.sourceId, cand);
  }

  // (2) Accessibility: explicit backend linkage first, else AX-only candidate.
  for (const ax of axNodes) {
    if (ax.ignored && !includeHidden) continue;
    const linked = ax.backendDomSourceId !== undefined ? byDom.get(ax.backendDomSourceId) : undefined;
    const cand =
      linked ??
      ({
        kind: "ax_only",
        frameId: ax.frameId,
        geometry: ax.backendDomSourceId !== undefined ? normalizedById.get(ax.backendDomSourceId)?.geometry : undefined,
        evidence: [],
        flags: [],
        roleClaims: [],
        nameClaims: [],
        textClaims: [],
      } satisfies Candidate);
    const claims: string[] = [];
    if (ax.role !== undefined) {
      claims.push(`role=${ax.role}`);
      cand.roleClaims.push({ sourceType: "accessibility", value: ax.role, confidence: BASE_CONFIDENCE.accessibility! });
    }
    if (ax.name !== undefined) {
      claims.push(`name=${ax.name}`);
      cand.nameClaims.push({ sourceType: "accessibility", value: ax.name, confidence: BASE_CONFIDENCE.accessibility! });
    }
    addClaim(cand, "accessibility", ax.sourceId, claims, BASE_CONFIDENCE.accessibility!);
    if (linked === undefined) extras.push(cand);
  }

  // (3) Text runs: linkage by domSourceId, else a standalone text candidate.
  for (const run of textRuns) {
    const linked = run.domSourceId !== undefined ? byDom.get(run.domSourceId) : undefined;
    const normText = normalizedById.get(run.sourceId)?.text;
    const value = normText?.redacted ? "" : (normText?.display ?? run.text);
    const cand =
      linked ??
      ({
        kind: "text",
        frameId: run.frameId,
        geometry: normalizedById.get(run.sourceId)?.geometry,
        evidence: [],
        flags: [],
        roleClaims: [],
        nameClaims: [],
        textClaims: [],
      } satisfies Candidate);
    if (value.length > 0) cand.textClaims.push({ sourceType: "text_run", value, confidence: BASE_CONFIDENCE.text_run! });
    addClaim(cand, "text_run", run.sourceId, value.length > 0 ? [`text=${value}`] : [], BASE_CONFIDENCE.text_run!);
    if (linked === undefined) extras.push(cand);
  }

  // (4) Visual/OCR candidates: fuse on overlap (never proximity), else standalone.
  const structured = [...byDom.values()].filter((c) => c.geometry !== undefined);
  for (const derived of capture.derivedObservations ?? []) {
    fuseDerived(derived, capture, structured, extras, iouThreshold);
  }

  // Finalize: stable order, synthetic ids, conflict flags + warnings, confidence.
  const all = [...byDom.values(), ...extras];
  all.sort(candidateOrder);

  const nodes: FusedNode[] = all.map((cand, i) => {
    const role = resolveFact("role", cand.roleClaims);
    const name = resolveFact("name", cand.nameClaims);
    const text = resolveFact("text", cand.textClaims);
    const flags = [...cand.flags];
    for (const [fact, resolved] of [["role", role], ["name", name], ["text", text]] as const) {
      if (resolved?.conflict) {
        flags.push(`conflict:${fact}`);
        warnings.push(warn("source_conflict", `sources disagree on ${fact} for candidate cand_${pad(i)}`, { frameId: cand.frameId }));
      }
    }
    const factConfidences = [role?.confidence, name?.confidence, text?.confidence].filter((c): c is number => c !== undefined);
    const confidence = factConfidences.length > 0 ? Math.min(...factConfidences) : cand.geometry ? 0.6 : 0.4;

    const node: FusedNode = {
      candidateId: `cand_${pad(i)}`,
      kind: cand.kind,
      frameId: cand.frameId,
      evidence: cand.evidence,
      flags,
      confidence,
    };
    if (cand.geometry !== undefined) (node as { geometry?: NormalizedGeometry }).geometry = cand.geometry;
    if (role !== undefined) (node as { role?: FusedFact<string> }).role = role;
    if (name !== undefined) (node as { name?: FusedFact<string> }).name = name;
    if (text !== undefined) (node as { text?: FusedFact<string> }).text = text;
    return node;
  });

  return { nodes, warnings };
}

function fuseDerived(
  derived: DerivedObservation,
  capture: CaptureBundleReadProfile,
  structured: Candidate[],
  extras: Candidate[],
  iouThreshold: number,
): void {
  if (derived.kind !== "vision_parser" && derived.kind !== "ocr") return;
  const screenshot = capture.screenshotEvidence?.find((s) => s.artifactRef === derived.sourceImageRef);
  const dsf = screenshot?.deviceScaleFactor;
  const items =
    derived.kind === "vision_parser"
      ? derived.elements.map((e) => ({ sourceId: e.sourceId, rect: e.rectImagePx, text: e.text, confidence: e.confidence }))
      : derived.runs.map((r) => ({ sourceId: r.sourceId, rect: r.rectImagePx, text: r.text, confidence: r.confidence }));
  const sourceType = derived.kind;

  for (const item of items) {
    const viewportRect: Rect | undefined =
      dsf !== undefined && dsf > 0
        ? { x: item.rect.x / dsf, y: item.rect.y / dsf, width: item.rect.width / dsf, height: item.rect.height / dsf }
        : undefined;
    const standaloneGeometry = screenshot !== undefined && viewportRect !== undefined
      ? derivedGeometry(capture, screenshot.frameId, viewportRect)
      : undefined;

    // Best-overlapping structured candidate (overlap, never proximity).
    let best: Candidate | undefined;
    let bestIou = 0;
    if (viewportRect !== undefined) {
      for (const cand of structured) {
        const score = iou(viewportRect, cand.geometry!.viewportRect);
        if (score > bestIou) {
          bestIou = score;
          best = cand;
        }
      }
    }

    const target =
      best !== undefined && bestIou >= iouThreshold
        ? best
        : ({
            kind: "visual",
            frameId: screenshot?.frameId ?? structured[0]?.frameId ?? "root",
            geometry: standaloneGeometry,
            evidence: [],
            flags: [],
            roleClaims: [],
            nameClaims: [],
            textClaims: [],
          } satisfies Candidate);

    const claims: string[] = [];
    if (item.text !== undefined && item.text.length > 0) {
      claims.push(`text=${item.text}`);
      target.textClaims.push({ sourceType, value: item.text, confidence: clamp01(item.confidence) });
    }
    addClaim(target, sourceType, item.sourceId, claims, clamp01(item.confidence), {
      artifactRef: derived.sourceImageRef,
      provider: derived.provider,
      providerVersion: derived.providerVersion,
      ...(standaloneGeometry !== undefined ? { coordinateSpaceId: standaloneGeometry.coordinateSpaceId } : {}),
    });
    if (target !== best) extras.push(target);
  }
}

function derivedGeometry(
  capture: CaptureBundleReadProfile,
  frameId: string,
  frameRect: Rect,
): NormalizedGeometry {
  const resolveFrame = (currentFrameId: string, seen: Set<string>): Affine => {
    if (seen.has(currentFrameId)) return IDENTITY;
    seen.add(currentFrameId);
    const document = capture.documents.find((candidate) => candidate.frameId === currentFrameId);
    if (document === undefined) return IDENTITY;
    const local = (document.transformToParent ?? IDENTITY) as Affine;
    return document.parentFrameId === undefined
      ? local
      : compose(resolveFrame(document.parentFrameId, seen), local);
  };
  const documentRect = transformRect(resolveFrame(frameId, new Set()), frameRect);
  const viewportRect = translateRect(
    documentRect,
    -capture.viewport.scrollXCssPx,
    -capture.viewport.scrollYCssPx,
  );
  const normalizedViewportRect: Rect = {
    x: viewportRect.x / capture.viewport.widthCssPx,
    y: viewportRect.y / capture.viewport.heightCssPx,
    width: viewportRect.width / capture.viewport.widthCssPx,
    height: viewportRect.height / capture.viewport.heightCssPx,
  };
  const ix0 = Math.max(0, viewportRect.x);
  const iy0 = Math.max(0, viewportRect.y);
  const ix1 = Math.min(capture.viewport.widthCssPx, viewportRect.x + viewportRect.width);
  const iy1 = Math.min(capture.viewport.heightCssPx, viewportRect.y + viewportRect.height);
  const visible = ix1 > ix0 && iy1 > iy0;
  const clipped = !visible || ix1 - ix0 < viewportRect.width - 1e-6 || iy1 - iy0 < viewportRect.height - 1e-6;
  return {
    frameId,
    frameRect,
    documentRect,
    viewportRect,
    normalizedViewportRect,
    coordinateSpaceId: `cs_frame_${frameId}`,
    visibility: !visible ? "offscreen" : clipped ? "clipped" : "visible",
    clipped,
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

/** Deterministic candidate ordering: frame, then geometry top-left, then a stable tiebreak. */
function candidateOrder(a: Candidate, b: Candidate): number {
  if (a.frameId !== b.frameId) return a.frameId < b.frameId ? -1 : 1;
  const ay = a.geometry?.viewportRect.y ?? Number.POSITIVE_INFINITY;
  const by = b.geometry?.viewportRect.y ?? Number.POSITIVE_INFINITY;
  if (ay !== by) return ay - by;
  const ax = a.geometry?.viewportRect.x ?? Number.POSITIVE_INFINITY;
  const bx = b.geometry?.viewportRect.x ?? Number.POSITIVE_INFINITY;
  if (ax !== bx) return ax - bx;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const aid = a.evidence[0]?.sourceId ?? "";
  const bid = b.evidence[0]?.sourceId ?? "";
  return aid < bid ? -1 : aid > bid ? 1 : 0;
}
