/**
 * Pipeline stage 2 — normalize (TRD §7, §8.2, ARCHITECTURE §3).
 *
 * Takes a validated capture and produces normalized facts in explicit
 * coordinate spaces:
 *  - builds the five `CoordinateSpace` kinds (document_css, viewport_css,
 *    frame_css, image_px, normalized);
 *  - flattens each frame's transform chain into document and viewport space and
 *    resolves every geometry-bearing claim to those spaces plus a normalized
 *    [0,1] viewport rect, all within the PRD §7.2 tolerance;
 *  - normalizes colors, CSS lengths, and match text WITHOUT discarding the
 *    original evidence (originals are retained on every normalized value);
 *  - classifies visibility and clipping against the viewport.
 *
 * Normalize is total: it never throws and never rejects. Structural rejection is
 * stage 1's job; here, anything it cannot resolve (e.g. a frame-transform cycle)
 * degrades to a safe default and records a warning.
 */

import type { CoordinateSpace, Rect } from "../types.js";
import type { CaptureBundleReadProfile, CaptureDocumentObservation } from "../readprofile.js";
import { compose, IDENTITY, transformRect, translateRect, type Affine } from "./geometry.js";
import { normalizeColor, type NormalizedColor } from "./color.js";
import { normalizeCssLength, type NormalizedLength } from "./css.js";
import { normalizeMatchText, type NormalizedText } from "./text.js";
import { warn, type PipelineIssue } from "./errors.js";

export type Visibility = "visible" | "clipped" | "offscreen" | "hidden";

export interface NormalizedGeometry {
  readonly frameId: string;
  /** Original frame-local bounds, preserved as evidence. */
  readonly frameRect: Rect;
  readonly documentRect: Rect;
  readonly viewportRect: Rect;
  readonly normalizedViewportRect: Rect;
  readonly coordinateSpaceId: string;
  readonly visibility: Visibility;
  readonly clipped: boolean;
}

export interface NormalizedNode {
  readonly sourceId: string;
  readonly frameId: string;
  readonly kind: "dom" | "text";
  readonly geometry?: NormalizedGeometry;
  readonly colors: Record<string, NormalizedColor>;
  readonly lengths: Record<string, NormalizedLength>;
  readonly text?: NormalizedText;
}

export interface NormalizedCapture {
  readonly coordinateSpaces: CoordinateSpace[];
  readonly nodes: NormalizedNode[];
  readonly warnings: PipelineIssue[];
}

const VIEWPORT_SPACE_ID = "cs_viewport";
const DOCUMENT_SPACE_ID = "cs_document";
const NORMALIZED_SPACE_ID = "cs_normalized";
const frameSpaceId = (frameId: string): string => `cs_frame_${frameId}`;
const imageSpaceId = (frameId: string, i: number): string => `cs_image_${frameId}_${i}`;

function looksLikeColorKey(key: string): boolean {
  return /colou?r/i.test(key);
}

/** Resolve every frame's transform up to the document root, guarding cycles. */
function frameToDocumentTransforms(
  docs: CaptureDocumentObservation[],
  warnings: PipelineIssue[],
): Map<string, Affine> {
  const byId = new Map<string, CaptureDocumentObservation>();
  for (const d of docs) byId.set(d.frameId, d);

  const resolved = new Map<string, Affine>();
  const resolve = (frameId: string, seen: Set<string>): Affine => {
    const cached = resolved.get(frameId);
    if (cached !== undefined) return cached;
    const doc = byId.get(frameId);
    if (doc === undefined) return IDENTITY;
    if (seen.has(frameId)) {
      warnings.push(warn("invalid_transform", `frame ${frameId} is part of a transform cycle; treating as root`, { frameId }));
      return IDENTITY;
    }
    seen.add(frameId);
    const local = (doc.transformToParent ?? IDENTITY) as Affine;
    const parentTransform =
      doc.parentFrameId !== undefined ? resolve(doc.parentFrameId, seen) : IDENTITY;
    const composed = compose(parentTransform, local);
    resolved.set(frameId, composed);
    return composed;
  };

  for (const d of docs) resolve(d.frameId, new Set());
  return resolved;
}

function classify(viewportRect: Rect, vw: number, vh: number, visibleFlag: boolean): {
  visibility: Visibility;
  clipped: boolean;
} {
  if (!visibleFlag) return { visibility: "hidden", clipped: false };
  const ix0 = Math.max(viewportRect.x, 0);
  const iy0 = Math.max(viewportRect.y, 0);
  const ix1 = Math.min(viewportRect.x + viewportRect.width, vw);
  const iy1 = Math.min(viewportRect.y + viewportRect.height, vh);
  const interW = ix1 - ix0;
  const interH = iy1 - iy0;
  if (interW <= 0 || interH <= 0) return { visibility: "offscreen", clipped: true };
  const fullyInside = interW >= viewportRect.width - 1e-6 && interH >= viewportRect.height - 1e-6;
  return fullyInside ? { visibility: "visible", clipped: false } : { visibility: "clipped", clipped: true };
}

function geometryFor(
  bounds: Rect,
  frameId: string,
  frameToDoc: Affine,
  vp: { vw: number; vh: number; sx: number; sy: number },
  visibleFlag: boolean,
): NormalizedGeometry {
  const documentRect = transformRect(frameToDoc, bounds);
  const viewportRect = translateRect(documentRect, -vp.sx, -vp.sy);
  const normalizedViewportRect: Rect = {
    x: viewportRect.x / vp.vw,
    y: viewportRect.y / vp.vh,
    width: viewportRect.width / vp.vw,
    height: viewportRect.height / vp.vh,
  };
  const { visibility, clipped } = classify(viewportRect, vp.vw, vp.vh, visibleFlag);
  return {
    frameId,
    frameRect: bounds,
    documentRect,
    viewportRect,
    normalizedViewportRect,
    coordinateSpaceId: frameSpaceId(frameId),
    visibility,
    clipped,
  };
}

export function normalizeCapture(capture: CaptureBundleReadProfile): NormalizedCapture {
  const warnings: PipelineIssue[] = [];
  const vp = {
    vw: capture.viewport.widthCssPx,
    vh: capture.viewport.heightCssPx,
    sx: capture.viewport.scrollXCssPx,
    sy: capture.viewport.scrollYCssPx,
  };
  const docs = capture.documents as CaptureDocumentObservation[];
  const frameToDoc = frameToDocumentTransforms(docs, warnings);
  const redacted = new Set(capture.redaction?.redactedSourceIds ?? []);

  const nodes: NormalizedNode[] = [];
  let docMaxX = vp.vw;
  let docMaxY = vp.vh;

  for (const doc of docs) {
    const t = frameToDoc.get(doc.frameId) ?? IDENTITY;

    for (const n of doc.domLayoutNodes) {
      const colors: Record<string, NormalizedColor> = {};
      const lengths: Record<string, NormalizedLength> = {};
      for (const [k, v] of Object.entries(n.styleFacts ?? {})) {
        if (typeof v === "string" && looksLikeColorKey(k)) {
          colors[k] = normalizeColor(v);
        } else {
          const len = normalizeCssLength(v);
          if (len.unit !== null) lengths[k] = len;
        }
      }
      let geometry: NormalizedGeometry | undefined;
      if (n.bounds !== undefined) {
        geometry = geometryFor(n.bounds, n.frameId, t, vp, n.visible);
        docMaxX = Math.max(docMaxX, geometry.documentRect.x + geometry.documentRect.width);
        docMaxY = Math.max(docMaxY, geometry.documentRect.y + geometry.documentRect.height);
      }
      nodes.push({ sourceId: n.sourceId, frameId: n.frameId, kind: "dom", geometry, colors, lengths });
    }

    for (const run of doc.textRuns ?? []) {
      const isRedacted = redacted.has(run.sourceId);
      let geometry: NormalizedGeometry | undefined;
      if (run.bounds !== undefined) {
        geometry = geometryFor(run.bounds, run.frameId, t, vp, true);
        docMaxX = Math.max(docMaxX, geometry.documentRect.x + geometry.documentRect.width);
        docMaxY = Math.max(docMaxY, geometry.documentRect.y + geometry.documentRect.height);
      }
      nodes.push({
        sourceId: run.sourceId,
        frameId: run.frameId,
        kind: "text",
        geometry,
        colors: {},
        lengths: {},
        text: normalizeMatchText(run.text, isRedacted),
      });
    }
  }

  const coordinateSpaces = buildCoordinateSpaces(capture, docs, vp, docMaxX, docMaxY);
  return { coordinateSpaces, nodes, warnings };
}

function buildCoordinateSpaces(
  capture: CaptureBundleReadProfile,
  docs: CaptureDocumentObservation[],
  vp: { vw: number; vh: number; sx: number; sy: number },
  docMaxX: number,
  docMaxY: number,
): CoordinateSpace[] {
  const spaces: CoordinateSpace[] = [
    { coordinateSpaceId: DOCUMENT_SPACE_ID, kind: "document_css", width: docMaxX, height: docMaxY },
    { coordinateSpaceId: VIEWPORT_SPACE_ID, kind: "viewport_css", width: vp.vw, height: vp.vh },
    { coordinateSpaceId: NORMALIZED_SPACE_ID, kind: "normalized", width: 1, height: 1 },
  ];

  for (const doc of docs) {
    const space: CoordinateSpace = {
      coordinateSpaceId: frameSpaceId(doc.frameId),
      kind: "frame_css",
      width: vp.vw,
      height: vp.vh,
    };
    if (doc.transformToParent !== undefined) space.transformToParent = doc.transformToParent;
    space.parentCoordinateSpaceId =
      doc.parentFrameId !== undefined ? frameSpaceId(doc.parentFrameId) : DOCUMENT_SPACE_ID;
    spaces.push(space);
  }

  capture.screenshotEvidence?.forEach((s, i) => {
    spaces.push({
      coordinateSpaceId: imageSpaceId(s.frameId, i),
      kind: "image_px",
      width: s.widthImagePx,
      height: s.heightImagePx,
      parentCoordinateSpaceId: frameSpaceId(s.frameId),
    });
  });

  return spaces;
}
