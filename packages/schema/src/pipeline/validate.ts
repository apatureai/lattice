/**
 * Pipeline stage 1: validate (TRD §8.1, ARCHITECTURE §3).
 *
 * Turns a supplied `CaptureBundleReadProfile` into a confirmed-well-formed
 * capture, or fails closed with structured errors and NO partial output. It
 * rejects unsupported source-schema majors, non-finite/overflow geometry,
 * duplicate source IDs, unresolved or cyclic parents, malformed redaction
 * metadata, tenant-leaking artifact refs, and derived observations missing
 * provider/version/confidence provenance.
 */

import type { Rect, Viewport } from "../types.js";
import {
  SUPPORTED_CAPTURE_MAJORS,
  SUPPORTED_DNA_PROJECTION_MAJORS,
  type CaptureBundleReadProfile,
  type CaptureDocumentObservation,
  type DerivedObservation,
  type AnyUIDNAReadProfile,
} from "../readprofile.js";
import { checkRect, isInBounds, isValidAffine } from "./geometry.js";
import { err, type PipelineIssue } from "./errors.js";

export type ValidateResult =
  | { ok: true; capture: CaptureBundleReadProfile; warnings: PipelineIssue[] }
  | { ok: false; errors: PipelineIssue[] };

/** Tenant-independent artifact ref: opaque `scheme:opaque`, no userinfo/whitespace. */
const ARTIFACT_REF = /^[a-z][a-z0-9+.-]*:[A-Za-z0-9._\-:/=+]+$/;

function majorOf(version: string): string | null {
  const head = version.split(".", 1)[0];
  return head !== undefined && /^\d+$/.test(head) ? head : null;
}

function validViewport(v: Viewport): boolean {
  const finite = [v.widthCssPx, v.heightCssPx, v.deviceScaleFactor, v.scrollXCssPx, v.scrollYCssPx];
  if (!finite.every((n) => Number.isFinite(n) && isInBounds(n))) return false;
  return v.widthCssPx > 0 && v.heightCssPx > 0 && v.deviceScaleFactor > 0;
}

function validArtifactRef(ref: string): boolean {
  return ARTIFACT_REF.test(ref) && !ref.includes("@");
}

function checkGeometry(
  rect: Rect | undefined,
  ctx: { sourceId: string; frameId: string },
  errors: PipelineIssue[],
): void {
  if (rect === undefined) return;
  const res = checkRect(rect);
  if (!res.ok) {
    errors.push(
      res.reason === "overflow"
        ? err("geometry_overflow", `geometry exceeds the legal coordinate magnitude`, ctx)
        : err("non_finite_geometry", `geometry has non-finite or negative-extent values`, ctx),
    );
  }
}

/** Depth-first cycle + missing-parent check over a single parent-linked tree. */
function checkParentTree(
  nodes: Array<{ sourceId: string; parentSourceId?: string; frameId: string }>,
  errors: PipelineIssue[],
): void {
  const parent = new Map<string, string | undefined>();
  for (const n of nodes) parent.set(n.sourceId, n.parentSourceId);

  for (const n of nodes) {
    if (n.parentSourceId !== undefined && !parent.has(n.parentSourceId)) {
      errors.push(
        err("missing_parent", `parentSourceId ${n.parentSourceId} does not resolve`, {
          sourceId: n.sourceId,
          frameId: n.frameId,
        }),
      );
    }
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.sourceId, WHITE);

  const visit = (start: string): boolean => {
    // Iterative walk up the parent chain; GREY marks the active path.
    let current: string | undefined = start;
    const path: string[] = [];
    while (current !== undefined) {
      const c = color.get(current);
      if (c === undefined) break; // missing parent already reported
      if (c === GREY) return true; // back-edge → cycle
      if (c === BLACK) break; // already proven acyclic
      color.set(current, GREY);
      path.push(current);
      current = parent.get(current);
    }
    for (const id of path) color.set(id, BLACK);
    return false;
  };

  for (const n of nodes) {
    if (color.get(n.sourceId) === WHITE && visit(n.sourceId)) {
      errors.push(err("parent_cycle", `parent chain from ${n.sourceId} is cyclic`, { sourceId: n.sourceId, frameId: n.frameId }));
    }
  }
}

function checkDerived(d: DerivedObservation, errors: PipelineIssue[]): void {
  const hasProvenance = d.provider.trim().length > 0 && d.providerVersion.trim().length > 0;
  if (!hasProvenance) {
    errors.push(err("derived_missing_provenance", `derived ${d.kind} observation lacks provider/providerVersion`));
  }
  const inUnit = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= 1;
  switch (d.kind) {
    case "vision_parser":
      if (!validArtifactRef(d.sourceImageRef)) errors.push(err("invalid_artifact_ref", `vision_parser sourceImageRef is not a tenant-independent ref`));
      for (const el of d.elements) {
        if (!inUnit(el.confidence)) errors.push(err("derived_missing_provenance", `vision_parser element ${el.sourceId} confidence out of [0,1]`, { sourceId: el.sourceId }));
        checkGeometry(el.rectImagePx, { sourceId: el.sourceId, frameId: "image" }, errors);
      }
      break;
    case "ocr":
      if (!validArtifactRef(d.sourceImageRef)) errors.push(err("invalid_artifact_ref", `ocr sourceImageRef is not a tenant-independent ref`));
      for (const run of d.runs) {
        if (!inUnit(run.confidence)) errors.push(err("derived_missing_provenance", `ocr run ${run.sourceId} confidence out of [0,1]`, { sourceId: run.sourceId }));
        checkGeometry(run.rectImagePx, { sourceId: run.sourceId, frameId: "image" }, errors);
      }
      break;
    case "embedding":
      if (!validArtifactRef(d.vectorRef)) errors.push(err("invalid_artifact_ref", `embedding vectorRef is not a tenant-independent ref`));
      if (!Number.isInteger(d.dimensions) || d.dimensions <= 0) errors.push(err("derived_missing_provenance", `embedding for ${d.targetSourceId} has non-positive dimensions`, { sourceId: d.targetSourceId }));
      break;
    case "learned_relation":
      if (!inUnit(d.confidence)) errors.push(err("derived_missing_provenance", `learned_relation ${d.fromSourceId}->${d.toSourceId} confidence out of [0,1]`));
      break;
  }
}

export function validateCapture(
  capture: CaptureBundleReadProfile,
  dna?: AnyUIDNAReadProfile,
): ValidateResult {
  const errors: PipelineIssue[] = [];
  const warnings: PipelineIssue[] = [];

  // 1. Source-schema majors.
  const captureMajor = majorOf(capture.schemaVersion);
  if (captureMajor === null || !(SUPPORTED_CAPTURE_MAJORS as readonly string[]).includes(captureMajor)) {
    errors.push(err("unsupported_capture_major", `unsupported capture schema version: ${capture.schemaVersion}`));
  }
  if (dna !== undefined) {
    const dnaMajor = majorOf(dna.projectionSchemaVersion);
    if (dnaMajor === null || !(SUPPORTED_DNA_PROJECTION_MAJORS as readonly string[]).includes(dnaMajor)) {
      errors.push(err("unsupported_dna_major", `unsupported DNA projection version: ${dna.projectionSchemaVersion}`));
    }
  }

  // 2. Viewport.
  if (!validViewport(capture.viewport)) {
    errors.push(err("invalid_viewport", `viewport has non-finite or non-positive dimensions`));
  }

  // 3. Redaction metadata.
  const redaction = capture.redaction;
  if (
    redaction === undefined ||
    typeof redaction.policyVersion !== "string" ||
    redaction.policyVersion.trim().length === 0 ||
    typeof redaction.applied !== "boolean" ||
    !Array.isArray(redaction.redactedSourceIds)
  ) {
    errors.push(err("invalid_redaction_metadata", `redaction metadata is missing or malformed`));
  }

  // 4. Per-document structure, geometry, parents; collect declared source IDs.
  const declared = new Map<string, number>();
  const declare = (id: string): void => {
    declared.set(id, (declared.get(id) ?? 0) + 1);
  };

  for (const doc of capture.documents as CaptureDocumentObservation[]) {
    if (typeof doc.frameId !== "string" || doc.frameId.length === 0) {
      errors.push(err("invalid_transform", `document is missing a frameId`));
    }
    if (doc.transformToParent !== undefined && !isValidAffine(doc.transformToParent)) {
      errors.push(err("invalid_transform", `frame ${doc.frameId} has a malformed transformToParent`, { frameId: doc.frameId }));
    }

    for (const n of doc.domLayoutNodes) {
      declare(n.sourceId);
      checkGeometry(n.bounds, { sourceId: n.sourceId, frameId: n.frameId }, errors);
    }
    for (const n of doc.accessibilityNodes) declare(n.sourceId);
    for (const t of doc.textRuns ?? []) {
      declare(t.sourceId);
      checkGeometry(t.bounds, { sourceId: t.sourceId, frameId: t.frameId }, errors);
    }

    checkParentTree(doc.domLayoutNodes, errors);
    checkParentTree(doc.accessibilityNodes, errors);
  }

  // 5. Screenshot evidence refs.
  for (const s of capture.screenshotEvidence ?? []) {
    if (!validArtifactRef(s.artifactRef)) {
      errors.push(err("invalid_artifact_ref", `screenshot artifactRef is not a tenant-independent ref`, { frameId: s.frameId }));
    }
    if (![s.widthImagePx, s.heightImagePx, s.deviceScaleFactor].every((n) => Number.isFinite(n) && isInBounds(n) && n > 0)) {
      errors.push(err("non_finite_geometry", `screenshot evidence has non-finite/non-positive dimensions`, { frameId: s.frameId }));
    }
  }

  // 6. Derived observations. vision/ocr elements declare new candidate source
  // IDs (subject to global uniqueness); embedding/learned_relation only
  // reference existing nodes, so they declare nothing.
  for (const d of capture.derivedObservations ?? []) {
    if (d.kind === "vision_parser") for (const el of d.elements) declare(el.sourceId);
    if (d.kind === "ocr") for (const run of d.runs) declare(run.sourceId);
    checkDerived(d, errors);
  }

  // 7. Global source-ID uniqueness.
  for (const [id, count] of declared) {
    if (count > 1) errors.push(err("duplicate_source_id", `source ID ${id} is declared ${count} times`, { sourceId: id }));
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, capture, warnings };
}
