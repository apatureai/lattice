/**
 * TypeScript types mirroring the normative UI Graph JSON Schemas.
 *
 * The JSON Schemas in `schemas/` are normative (TRD §5, §10, §12). These types
 * explain the same semantics for TypeScript consumers; `test/types.test.ts`
 * asserts representative instances validate against the schemas so the two
 * descriptions cannot drift silently.
 *
 * Every snapshot field except `snapshotId` and `contentHash` is semantic and is
 * covered by the content hash (TRD §5.1, §9.2).
 */

export const SCHEMA_VERSION = "1.0.0" as const;

// --- Geometry primitives -------------------------------------------------

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Normalized viewport rect in [0,1] (TRD §7). */
export type NormalizedRect = Rect;

export type CoordinateSpace = {
  coordinateSpaceId: string;
  kind: "document_css" | "viewport_css" | "frame_css" | "image_px" | "normalized";
  width: number;
  height: number;
  transformToParent?: [number, number, number, number, number, number];
  parentCoordinateSpaceId?: string;
};

export type Viewport = {
  widthCssPx: number;
  heightCssPx: number;
  deviceScaleFactor: number;
  scrollXCssPx: number;
  scrollYCssPx: number;
};

// --- Use mode (feature-flag / experiment framing, TRD §4.3, §5.2) --------

/**
 * Build/use mode. Per core #103 DECISION 4 and PRD §9, UI Graph is a
 * feature-flagged representation experiment: it runs in `offline_eval` or
 * `shadow` until its eval proves value, and only then in `production`.
 * Non-production modes force every DNA match to `authoritative: false`.
 */
export type UIGraphUseMode = "production" | "offline_eval" | "shadow";

// --- Evidence ------------------------------------------------------------

export type EvidenceClaim = {
  sourceType:
    | "dom"
    | "layout"
    | "accessibility"
    | "computed_style"
    | "text_run"
    | "screenshot"
    | "vision_parser"
    | "ocr"
    | "ui_dna";
  sourceId?: string;
  artifactRef?: string;
  coordinateSpaceId?: string;
  provider?: string;
  providerVersion?: string;
  confidence: number;
  claims: string[];
};

// --- DNA projection ------------------------------------------------------

export type UIDNAMatch = {
  dnaRef: string;
  category: "token" | "scale" | "component_family" | "rule" | "exception";
  status: "exact" | "within_tolerance" | "drift" | "unknown" | "excepted";
  observed?: string | number;
  canonical?: string | number;
  delta?: number;
  method:
    | "exact_value"
    | "numeric_tolerance"
    | "declared_component"
    | "structural_signature"
    | "embedding_candidate"
    | "rule_evaluation";
  authoritative: boolean;
  confidence: number;
  evidence: EvidenceClaim[];
};

export type UIDNAProjection = {
  dnaVersion: string;
  projectionSchemaVersion: string;
  dnaContentDigest: string;
  state: "approved" | "draft" | "in_review" | "superseded" | "revoked";
  useMode: UIGraphUseMode;
  authoritativeMatchCount: number;
  advisoryMatchCount: number;
  driftCount: number;
};

// --- Node ----------------------------------------------------------------

/** Perception-only interaction affordance; mirrors the normative JSON Schema. */
export type UIAffordance =
  | "click"
  | "type"
  | "select"
  | "toggle"
  | "scroll"
  | "hover"
  | "focus"
  | "drag"
  | "navigate"
  | "submit";

export type LocatorHint = {
  kind:
    | "explicit_test_id"
    | "role_name"
    | "label"
    | "href_or_form_name"
    | "stable_dom_id"
    | "text"
    | "structural_path"
    | "css"
    | "xpath"
    | "geometry";
  value: string;
  scope: "capture_session" | "route_version" | "cross_capture_candidate";
  uniqueness: number;
  stability: number;
  confidence: number;
};

export type SensitivityLabel =
  | "public"
  | "tenant_private"
  | "pii"
  | "secret"
  | "credential"
  | "redacted";

export type UIGraphNode = {
  nodeId: string;
  elementRef: string;
  kind:
    | "document"
    | "region"
    | "element"
    | "text"
    | "control"
    | "image"
    | "canvas"
    | "visual_candidate";
  parentNodeId?: string;
  regionIds: string[];
  semantics: {
    role?: string;
    name?: string;
    description?: string;
    text?: string;
    states: Record<string, string | number | boolean | null>;
  };
  geometry: {
    documentRect?: Rect;
    viewportRect?: Rect;
    visibleRect?: Rect;
    normalizedViewportRect?: NormalizedRect;
    frameId: string;
    clipped: boolean;
    occlusion?: "none" | "partial" | "full" | "unknown";
    paintOrder?: number;
  };
  style: {
    color?: string;
    backgroundColor?: string;
    fontFamily?: string;
    fontSizeCssPx?: number;
    fontWeight?: number;
    lineHeightCssPx?: number;
    borderRadiusCssPx?: number[];
    opacity?: number;
    display?: string;
    position?: string;
    zIndex?: number | "auto";
    spacing?: Record<string, number>;
  };
  affordances: UIAffordance[];
  dnaMatches: UIDNAMatch[];
  locatorHints: LocatorHint[];
  evidence: EvidenceClaim[];
  sensitivity: SensitivityLabel[];
  confidence: number;
  flags: string[];
};

// --- Edge ----------------------------------------------------------------

export type UIGraphEdge = {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  kind:
    | "contains"
    | "labels"
    | "controls"
    | "reading_next"
    | "overlaps"
    | "aligned_start"
    | "aligned_center"
    | "aligned_end"
    | "near"
    | "groups"
    | "learned";
  directed: boolean;
  weight: number;
  attributes: Record<string, string | number | boolean | null>;
  evidence: EvidenceClaim[];
};

// --- Region --------------------------------------------------------------

export type UIRegion = {
  regionId: string;
  rootNodeId: string;
  kind:
    | "document"
    | "landmark"
    | "form"
    | "list"
    | "table"
    | "repeated"
    | "visual_group"
    | "custom";
  label?: string;
  memberNodeIds: string[];
  summary: {
    itemCount?: number;
    visibleItemCount?: number;
    repeatedPatternHash?: string;
  };
  evidence: EvidenceClaim[];
  confidence: number;
};

// --- Snapshot metadata ---------------------------------------------------

export type UIGraphBuildMetadata = {
  builderVersion: string;
  relationPolicyVersion: string;
  dnaProjectionVersion: string;
  redactionPolicyVersion: string;
  deterministicInputHash: string;
};

export type UIGraphSourceMetadata = {
  captureId: string;
  captureSchemaVersion: string;
  captureVersion: string;
  repository: { owner: string; name: string };
  route: string;
  headSha?: string;
  viewport: Viewport;
  dnaVersion?: string;
  dnaProjectionSchemaVersion?: string;
  dnaContentDigest?: string;
  dnaState?: "approved" | "draft" | "in_review" | "superseded" | "revoked";
  /**
   * Use mode of the DNA projection. Present only when DNA is supplied. The
   * build/use mode also lives in `UIGraphBuildOptions.useMode` (TRD §4.3, §5.2)
   * so non-DNA shadow builds still record their experiment mode in the
   * deterministic input hash and cache key (issue #23).
   */
  dnaUseMode?: UIGraphUseMode;
  derivedProviders: Array<{
    kind: string;
    provider: string;
    providerVersion: string;
  }>;
};

export type UIGraphMetrics = {
  source: {
    domNodes: number;
    accessibilityNodes: number;
    visualCandidates: number;
  };
  graph: {
    nodes: number;
    edges: number;
    regions: number;
    maxDegree: number;
    conflictCount: number;
  };
  coverage: {
    structuredVisibleAreaRatio?: number;
    parserOnlyAreaRatio?: number;
    accessibleInteractiveRatio?: number;
  };
};

export type UIGraphWarning = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  nodeIds?: string[];
};

// --- Snapshot ------------------------------------------------------------

export type UIGraphSnapshot = {
  schemaVersion: typeof SCHEMA_VERSION;
  snapshotId: string;
  contentHash: string;
  build: UIGraphBuildMetadata;
  source: UIGraphSourceMetadata;
  coordinateSpaces: CoordinateSpace[];
  nodes: UIGraphNode[];
  edges: UIGraphEdge[];
  regions: UIRegion[];
  dnaProjection?: UIDNAProjection;
  metrics: UIGraphMetrics;
  warnings: UIGraphWarning[];
};

/**
 * Ref-free input accepted by `sealSnapshot` before snapshot identity exists.
 *
 * Builders own semantic node IDs, but the canonical sealer owns snapshot-local
 * `elementRef`, `contentHash`, and `snapshotId` assignment. Callers may pass an
 * already-sealed snapshot for idempotent verification; any supplied identity
 * that does not match the recomputed tuple is rejected.
 */
export type UIGraphSnapshotDraft = Omit<
  UIGraphSnapshot,
  "snapshotId" | "contentHash" | "nodes"
> & {
  snapshotId?: string;
  contentHash?: string;
  nodes: Array<Omit<UIGraphNode, "elementRef"> & { elementRef?: string }>;
};

// --- View ----------------------------------------------------------------

export type UIGraphViewSpec = {
  kind: "summary" | "violations" | "focus" | "actionMap" | "patchContext" | "diff";
  refs?: string[];
  task?: string;
  comparisonSnapshotId?: string;
  comparisonContentHash?: string;
  maxTextTokens: number;
  maxNodes: number;
  maxEdges: number;
  maxCrops: number;
  includeSensitive: false;
  tokenizerProfile: string;
  visualTokenProfile?: string;
  rendererVersion: string;
};

export type EvidenceRequest = {
  requestId: string;
  kind: "crop" | "full_screenshot" | "marked_overlay";
  sourceArtifactRef: string;
  coordinateSpaceId: string;
  rect?: Rect;
  elementRefs: string[];
  reason: string;
  priority: number;
};

export type UIGraphView = {
  schemaVersion: typeof SCHEMA_VERSION;
  snapshotId: string;
  snapshotContentHash: string;
  viewId: string;
  specHash: string;
  spec: UIGraphViewSpec;
  text: string;
  includedNodeIds: string[];
  includedEdgeIds: string[];
  evidenceRequests: EvidenceRequest[];
  budget: {
    estimatedTextTokens: number;
    estimatedVisualTokens: number;
    serializedBytes: number;
    includedNodes: number;
    includedEdges: number;
    includedCrops: number;
  };
  truncation: {
    truncated: boolean;
    reasons: string[];
    omittedNodeCount: number;
    omittedEdgeCount: number;
  };
  warnings: string[];
};

// --- Delta ---------------------------------------------------------------

export type UIGraphDeltaOperation =
  | { op: "replace_header"; build: UIGraphBuildMetadata; source: UIGraphSourceMetadata; coordinateSpaces: CoordinateSpace[] }
  | { op: "upsert_node"; node: UIGraphNode }
  | { op: "remove_node"; nodeId: string }
  | { op: "upsert_edge"; edge: UIGraphEdge }
  | { op: "remove_edge"; edgeId: string }
  | { op: "upsert_region"; region: UIRegion }
  | { op: "remove_region"; regionId: string }
  | { op: "replace_dna_projection"; dnaProjection?: UIDNAProjection }
  | { op: "replace_metrics"; metrics: UIGraphMetrics }
  | { op: "replace_warnings"; warnings: UIGraphWarning[] };

export type UIGraphDelta = {
  schemaVersion: typeof SCHEMA_VERSION;
  deltaId: string;
  baseSnapshotSchemaVersion: typeof SCHEMA_VERSION;
  baseSnapshotId: string;
  baseContentHash: string;
  targetSnapshotSchemaVersion: typeof SCHEMA_VERSION;
  targetSnapshotId: string;
  targetContentHash: string;
  sequence: number;
  operations: UIGraphDeltaOperation[];
  createdAt: string;
};
