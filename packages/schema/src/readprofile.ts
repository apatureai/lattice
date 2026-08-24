/**
 * Cross-repo input read profiles (TRD §4).
 *
 * UI Graph does not redefine the producers' full schemas. It declares the
 * MINIMUM read profiles it consumes and records the source schema versions.
 * These types mirror only what UI Graph reads (TRD §4.1-§4.4); they are NOT a
 * fabricated copy of the upstream `@uidna/schema` or engine capture schema. The
 * adapter validates this explicit read profile, while the UI Graph snapshot
 * schema itself stays closed (TRD §4.1 final paragraph).
 *
 * `CaptureBundleReadProfile` below is the shape a capture adapter has to
 * produce. One ships in this repository, in `packages/capture`
 * (`@apatureai/lattice-capture`): a Playwright/CDP adapter that fills this exact
 * shape from a real page. It deliberately lives OUTSIDE this package, because
 * the core library has no browser capability and the capability guard enforces
 * that. Any other adapter that fills this shape is equally a producer; the
 * golden fixtures under `test/fixtures/capture/` plus `syntheticCapture()` are
 * what one can be checked against without a browser.
 */

import type { Rect, Viewport } from "./types.js";

// --- Supported source majors --------------------------------------------

/** Source-schema majors UI Graph can read. Unsupported majors are rejected (TRD §8.1). */
export const SUPPORTED_CAPTURE_MAJORS = ["1"] as const;
export const SUPPORTED_DNA_PROJECTION_MAJORS = ["1"] as const;

// --- Capture read profile (TRD §4.1) ------------------------------------

export type CaptureDomLayoutNode = {
  sourceId: string;
  parentSourceId?: string;
  frameId: string;
  role?: string;
  tag?: string;
  /**
   * Durable DOM attributes, if the capture collected any. UI Graph reads only
   * the four that survive a re-render (`data-testid`, `id`, `href`, `name`)
   * and turns them into cross-capture locator hints. Without them the lineage
   * matcher has no explicit-id feature and can only abstain (TRD §6.4).
   */
  attributes?: Record<string, string>;
  bounds?: Rect;
  visible: boolean;
  paintOrder?: number;
  zIndex?: number | "auto";
  styleFacts?: Record<string, string | number>;
  textSourceIds?: string[];
};

export type CaptureAccessibilityNode = {
  sourceId: string;
  parentSourceId?: string;
  frameId: string;
  role?: string;
  name?: string;
  description?: string;
  state?: Record<string, string | number | boolean | null>;
  ignored: boolean;
  ignoredReasons?: string[];
  backendDomSourceId?: string;
};

export type CaptureTextRun = {
  sourceId: string;
  frameId: string;
  text: string;
  domSourceId?: string;
  bounds?: Rect;
};

export type CaptureDocumentObservation = {
  frameId: string;
  parentFrameId?: string;
  url?: string;
  transformToParent?: [number, number, number, number, number, number];
  domLayoutNodes: CaptureDomLayoutNode[];
  accessibilityNodes: CaptureAccessibilityNode[];
  textRuns?: CaptureTextRun[];
};

export type ScreenshotEvidenceRef = {
  artifactRef: string;
  frameId: string;
  widthImagePx: number;
  heightImagePx: number;
  deviceScaleFactor: number;
};

/** Derived observations are produced OUTSIDE UI Graph; it validates, never invokes (TRD §4.2). */
export type DerivedObservation =
  | {
      kind: "vision_parser";
      provider: string;
      providerVersion: string;
      sourceImageRef: string;
      elements: Array<{
        sourceId: string;
        rectImagePx: Rect;
        class?: string;
        text?: string;
        confidence: number;
      }>;
    }
  | {
      kind: "ocr";
      provider: string;
      providerVersion: string;
      sourceImageRef: string;
      runs: Array<{
        sourceId: string;
        rectImagePx: Rect;
        text: string;
        confidence: number;
      }>;
    }
  | {
      kind: "embedding";
      provider: string;
      providerVersion: string;
      targetSourceId: string;
      vectorRef: string;
      dimensions: number;
    }
  | {
      kind: "learned_relation";
      provider: string;
      providerVersion: string;
      fromSourceId: string;
      toSourceId: string;
      relation: string;
      confidence: number;
    };

export type CaptureBundleReadProfile = {
  schemaVersion: string;
  captureId: string;
  captureVersion: string;
  repository: { owner: string; name: string };
  route: string;
  headSha?: string;
  viewport: Viewport;
  documents: CaptureDocumentObservation[];
  screenshotEvidence?: ScreenshotEvidenceRef[];
  pageHealth: {
    stable: boolean;
    partial: boolean;
    reasons: string[];
  };
  redaction: {
    policyVersion: string;
    applied: boolean;
    redactedSourceIds: string[];
  };
  derivedObservations?: DerivedObservation[];
};

// --- UI-DNA read profile (TRD §4.3) -------------------------------------

export type UIDNAToken = {
  value: string | number;
  category: string;
  confidence: number;
};

export type UIDNAGraphProjectionReadProfile = {
  projectionSchemaVersion: string;
  dnaVersion: string;
  dnaContentDigest: string;
  state: "approved";
  tokens: Record<string, UIDNAToken>;
  semanticRoles: unknown[];
  componentFamilies: unknown[];
  distributions: unknown[];
  rules: unknown[];
  exceptions: unknown[];
  contexts: unknown[];
};

export type ExperimentalUIDNAReadProfile = Omit<
  UIDNAGraphProjectionReadProfile,
  "state"
> & {
  state: "draft" | "in_review" | "superseded" | "revoked";
  useMode: "offline_eval" | "shadow";
};

export type AnyUIDNAReadProfile =
  | UIDNAGraphProjectionReadProfile
  | ExperimentalUIDNAReadProfile;
