# Apature UI Graph — Technical Requirements

Created: 2026-06-16
Revised: 2026-06-18
Status: build-ready technical specification
Normative schemas:

- `schemas/ui-graph-snapshot.schema.json`
- `schemas/ui-graph-view.schema.json`
- `schemas/ui-graph-delta.schema.json`

## 1. Technical Summary

UI Graph is a deterministic representation package consumed by Judgment Engine. It accepts versioned capture observations and an optional UI-DNA graph projection, emits one immutable content-addressed graph, and renders bounded task-focused views from that graph.

The MVP is a library/package, not a network service. Judgment Engine owns orchestration, storage, tenancy, artifact authorization, inference, and eval execution.

```ts
buildUiGraph(request: BuildUiGraphRequest): Promise<UIGraphBuildResult>
queryUiGraph(request: QueryUiGraphRequest): UIGraphView
diffUiGraphs(base: UIGraphSnapshot, target: UIGraphSnapshot): UIGraphDiff
applyUiGraphDelta(base: UIGraphSnapshot, delta: UIGraphDelta): UIGraphSnapshot
```

```ts
type QueryUiGraphRequest = {
  snapshot: UIGraphSnapshot;
  spec: UIGraphViewSpec;
  comparisonSnapshot?: UIGraphSnapshot;
};
```

`comparisonSnapshot` is required only for `kind: "diff"` and must match the comparison ID/hash carried in the normalized view spec.

## 2. Design Invariants

1. Inputs are observations, not truth.
2. The graph is immutable after its content hash is assigned.
3. `elementRef` is snapshot-local and opaque.
4. Cross-snapshot identity is probabilistic and may abstain.
5. Pixels, crops, OCR output, and embeddings are referenced or supplied; this package does not produce them.
6. Persisted edges are bounded O(n); dense similarity is query-time.
7. UI-DNA matches are projections against an externally owned version.
8. Prompt views are lossy and must report truncation and omitted evidence.
9. All page-derived text is untrusted data.
10. Full snapshots are canonical; deltas are transport artifacts.

## 3. Deployment and Ownership

### 3.1 MVP deployment

- Published versioned package, for example `@apature/ui-graph`.
- Loaded by a Judgment Engine worker after capture and UI-DNA resolution.
- No database credentials, model credentials, browser handles, or network fetch capability.
- Deterministic build given byte-identical normalized inputs and builder version.

### 3.2 Judgment Engine responsibilities

- Validate tenant and artifact authorization.
- Read capture/UI-DNA artifacts.
- Produce optional OCR, parser, embedding, or learned observations.
- Call UI Graph.
- Store snapshot blobs and indexes.
- Fetch/serve screenshot evidence.
- Assemble model prompts and run evaluation.

### 3.3 UI Graph responsibilities

- Validate source profiles and compatible versions.
- Normalize and fuse supplied observations.
- Generate graph IDs, references, deterministic relations, DNA projections, metrics, views, diffs, and deltas.
- Return structured errors without partial hash-valid output.

## 4. Cross-Repo Input Contract

UI Graph does not redefine the full Judgment Engine or UI DNA schemas. It defines minimum read profiles and records the source schema versions it consumed.

```ts
type BuildUiGraphRequest = {
  capture: CaptureBundleReadProfile;
  dna?: UIDNAGraphProjectionReadProfile | ExperimentalUIDNAReadProfile;
  options: UIGraphBuildOptions;
};
```

Contract status on 2026-06-18:

- this is the target UI Graph consumer profile, not the current checked-in Judgment Engine `Capture` type;
- the current engine type supplies images, selector geometry, and coarse page health, so a producer-owned `CaptureBundle` schema and golden fixture are an R0 prerequisite;
- UI DNA must publish the producer-owned `GraphProjection` schema before production integration.

### 4.1 Capture read profile

```ts
type CaptureBundleReadProfile = {
  schemaVersion: string;
  captureId: string;
  captureVersion: string;
  repository: { owner: string; name: string };
  route: string;
  headSha?: string;
  viewport: {
    widthCssPx: number;
    heightCssPx: number;
    deviceScaleFactor: number;
    scrollXCssPx: number;
    scrollYCssPx: number;
  };
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
```

Each `CaptureDocumentObservation` must provide:

- frame/document identity and parent transform;
- DOM/layout nodes with source-local IDs, parent linkage, bounds, visibility, paint/stacking facts, selected style facts, and text linkage;
- accessibility nodes with source-local IDs, parent linkage, role, name, description, state, ignored status/reasons, and backend DOM linkage where available;
- text runs or text linkage where available.

The exact owner schema may include more fields. The adapter selects and validates this explicit read profile; the UI Graph snapshot schema itself remains closed.

### 4.2 Derived observations

Derived observations are optional outputs produced outside UI Graph:

```ts
type DerivedObservation =
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
```

UI Graph validates and records these observations. It does not invoke the providers.

### 4.3 UI-DNA read profile

```ts
type UIDNAGraphProjectionReadProfile = {
  projectionSchemaVersion: string;
  dnaVersion: string;
  dnaContentDigest: string;
  state: "approved";
  tokens: Record<string, UIDNAToken>;
  semanticRoles: UIDNASemanticRole[];
  componentFamilies: UIDNAComponentFamily[];
  distributions: UIDNADistribution[];
  rules: UIDNARule[];
  exceptions: UIDNAException[];
  contexts: UIDNAContext[];
};

type ExperimentalUIDNAReadProfile = Omit<
  UIDNAGraphProjectionReadProfile,
  "state"
> & {
  state: "draft" | "in_review" | "superseded" | "revoked";
  useMode: "offline_eval" | "shadow";
};
```

Production builds accept only `state: "approved"`. Experimental profiles require explicit Judgment Engine authorization and force every DNA match to `authoritative: false`. Every DNA fact must carry confidence and provenance in the owner schema. UI Graph preserves the source state and never upgrades it.

### 4.4 Build options

```ts
type UIGraphBuildOptions = {
  builderVersion: string;
  schemaVersion: string;
  relationPolicyVersion: string;
  dnaProjectionVersion: string;
  redactionPolicyVersion: string;
  maxNodes: number;
  maxPersistedEdgesPerNode: number;
  repeatedRegionThreshold: number;
  textPolicy: "full" | "truncate" | "hash_sensitive";
  includeHiddenExplanatoryNodes: boolean;
};
```

Options that change graph semantics must be versioned and included in the content hash.

## 5. Output Contract

The JSON Schema is normative. The following types explain semantics.

```ts
type UIGraphSnapshot = {
  schemaVersion: string;
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
```

```ts
type UIGraphBuildResult = {
  snapshot: UIGraphSnapshot;
  diagnostics: {
    builtAt: string;
    timingMs: {
      validate: number;
      normalize: number;
      fuse: number;
      relations: number;
      dnaProjection: number;
      serialize: number;
      total: number;
    };
    peakMemoryBytes?: number;
    canonicalJsonBytes: number;
    compressedBytes?: number;
    counters: Record<string, number>;
  };
};
```

### 5.1 Build metadata

```ts
type UIGraphBuildMetadata = {
  builderVersion: string;
  relationPolicyVersion: string;
  dnaProjectionVersion: string;
  redactionPolicyVersion: string;
  deterministicInputHash: string;
};
```

Wall-clock build time and stage timings belong to `UIGraphBuildResult.diagnostics`, not the immutable snapshot. All snapshot fields except `snapshotId` and `contentHash` are semantic and included in the hash projection.

### 5.2 Source metadata

```ts
type UIGraphSourceMetadata = {
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
  dnaUseMode?: "production" | "offline_eval" | "shadow";
  derivedProviders: Array<{
    kind: string;
    provider: string;
    providerVersion: string;
  }>;
};
```

When `dnaProjection` is present, all DNA source fields are required and must equal the projection’s version, digest, state, and use mode. JSON Schema enforces presence; the builder enforces cross-field equality.

### 5.3 Node

```ts
type UIGraphNode = {
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
```

Rules:

- Missing is different from `unknown`; do not invent empty values.
- Text fields must already satisfy redaction policy.
- Raw source IDs belong only in evidence claims, not in external refs.
- Confidence is calibrated per fact where possible; node confidence is the conservative aggregate.

### 5.4 Evidence claim

```ts
type EvidenceClaim = {
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
```

Conflicting claims must coexist. A conflict adds a warning/flag and lowers the affected fact confidence.

### 5.5 Edge

```ts
type UIGraphEdge = {
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
```

Persisted-edge requirements:

- `contains`, `labels`, `controls`, and `reading_next` are directed.
- symmetric edges use canonical `(min(nodeId), max(nodeId))` ordering.
- each node has at most `maxPersistedEdgesPerNode` non-structural edges.
- `same_component_family`, token similarity, and embedding-neighbor relations are query-time filters unless an explicit benchmark justifies persistence.

### 5.6 Region

```ts
type UIRegion = {
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
```

Repeated regions keep representative children plus aggregate facts in compact views; the canonical snapshot may retain all nodes up to `maxNodes`.

### 5.7 UI-DNA match

```ts
type UIDNAMatch = {
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
```

Only deterministic exact/tolerance/rule matches can be `authoritative: true`, and only against approved DNA. Embedding candidates are always advisory.

## 6. Identity and Reference Contract

### 6.1 Node IDs

`nodeId` is stable only inside one canonical snapshot. It is deterministically derived from:

- document/frame key;
- preferred source linkage;
- normalized ancestor identity;
- node-kind discriminator;
- collision ordinal.

It must not include mutable prompt text or array position alone.

### 6.2 Element refs

Format:

```text
ug:<ref-scope-prefix>:<node-ordinal>
```

**Pre-R0 identity correction (July 12, 2026).** `ref-scope-prefix` is the first
eight hexadecimal characters of a SHA-256 digest over the canonical semantic
snapshot with `snapshotId`, `contentHash`, and every `elementRef` omitted. Nodes
are sorted deterministically before ordinals are assigned. The final
`contentHash` is computed only after refs are assigned and therefore covers the
refs without requiring a circular hash fixed point. The short prefix is a prompt
convenience, not authority: resolution always verifies the exact
`(snapshotId, contentHash)` tuple and recomputes the full ref-scope digest.

Requirements:

- short enough for repeated prompt use;
- unique in the snapshot;
- no semantic promise encoded in the ordinal;
- rejected when used with a different snapshot ID;
- resolvable to node, geometry, evidence, and locator hints.

### 6.3 Locator hints

```ts
type LocatorHint = {
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
```

Preferred candidate order:

1. allowlisted application-owned test/apature ID;
2. role + accessible name + frame/region;
3. explicit label association, stable href, or form name;
4. non-generated DOM ID;
5. structural path plus stable text hash;
6. CSS/XPath fallback;
7. geometry fallback.

Browser/CDP/AX/BiDi handles are `capture_session` only.

### 6.4 Cross-snapshot matching

```ts
type UIGraphNodeMatch = {
  baseNodeId: string;
  targetNodeId?: string;
  status: "matched" | "removed" | "ambiguous" | "abstained";
  score: number;
  features: Array<{ name: string; score: number }>;
};
```

Candidate features:

- explicit ID equality;
- role/name/label similarity;
- stable attributes;
- ancestor/region match;
- text similarity after redaction;
- component-family/DNA match;
- relative geometry and size;
- sibling/order context;
- optional embedding similarity.

High-confidence threshold is calibrated on `ug-lineage`. Ambiguous top candidates must abstain.

## 7. Coordinate and Grounding Contract

Every geometry-bearing claim identifies a coordinate space.

Required coordinate spaces:

- document CSS pixels;
- viewport CSS pixels;
- frame-local CSS pixels;
- source screenshot pixels;
- normalized viewport `[0,1]`.

```ts
type CoordinateSpace = {
  coordinateSpaceId: string;
  kind: "document_css" | "viewport_css" | "frame_css" | "image_px" | "normalized";
  width: number;
  height: number;
  transformToParent?: [number, number, number, number, number, number];
  parentCoordinateSpaceId?: string;
};
```

Crops and overlays must include:

- source artifact ref;
- source rectangle;
- output dimensions;
- affine transform to viewport/document space;
- clipping and padding;
- included `elementRef` values.

Coordinates used in prompts are derived from canonical geometry; they are not authoritative browser selectors.

## 8. Build Pipeline

### 8.1 Validate

- Reject unsupported source-schema majors.
- Validate coordinate spaces, finite numeric values, unique source IDs, and parent acyclicity.
- Verify redaction metadata and tenant-independent artifact-ref shape.
- Reject derived observations without provider/version/confidence.

### 8.2 Normalize

- Flatten frame transforms into document and viewport coordinates.
- Normalize colors and CSS numeric values without discarding original evidence.
- Normalize whitespace and Unicode for matching; preserve redacted display text separately.
- Classify visibility and clipping.

### 8.3 Generate candidates

- Start from visible layout nodes.
- Add accessible controls/text nodes missing a direct visible layout counterpart.
- Add visual-parser candidates that do not sufficiently overlap a structured node.
- Retain explanatory hidden nodes only when enabled and necessary for labels/relationships.

### 8.4 Fuse observations

Matching order:

1. explicit backend/source linkage;
2. frame + high IoU + compatible role/text;
3. label/control linkage;
4. OCR/text overlap;
5. visual candidate overlap and semantic compatibility.

Never merge solely on proximity. Preserve source claims and conflicts.

### 8.5 Build hierarchy and regions

- DOM/layout containment is the initial hierarchy.
- AX-only or visual-only nodes attach to the smallest compatible containing region.
- Landmarks/forms/lists/tables become semantic regions.
- Repeated regions require a deterministic signature over role/style/size/order.
- Region summaries must not remove canonical nodes before `maxNodes` pressure requires explicit truncation.

### 8.6 Build bounded relations

- `contains`: hierarchy.
- `labels`/`controls`: explicit accessibility/DOM linkage.
- `reading_next`: accessibility/source order corrected by geometry within a region.
- `overlaps`: only above configured IoU/intersection threshold.
- alignment: within configured CSS-pixel or relative tolerance and same region.
- `near`: k nearest meaningful neighbors by direction, not all pairs.
- `groups`: deterministic visual grouping only when evidence threshold is met.
- externally learned relations use `kind: learned`.

Spatial candidate generation must use a spatial index or sweep-line equivalent, not an unconditional O(n²) scan.

### 8.7 Project UI DNA

- Exact normalized token equality first.
- Numeric scale matching with category-specific tolerance.
- Approved exceptions before emitting drift.
- Component matching from declarations/structural signatures.
- Optional embedding candidates recorded as advisory.
- Missing DNA disables conformance claims. Authorized non-canonical evaluation data forces non-authoritative matches and is visible in every affected view.

### 8.8 Assign IDs and serialize

- Sort nodes by deterministic document/frame/reading order before assigning short refs.
- Sort all id-addressed collections by ID for canonical serialization.
- Compute the ref-scope digest with identity fields and refs omitted; assign refs from that digest plus the sorted node ordinal.
- Canonicalize semantic JSON using RFC 8785-compatible rules.
- Compute the final SHA-256 content hash including the assigned refs.
- Derive `snapshotId` from hash plus schema major.
- Recompute and verify the ref-scope/ref/hash/ID invariants, then revalidate against JSON Schema after hashing metadata is inserted.

## 9. Canonical Serialization and Versioning

### 9.1 JSON rules

- UTF-8 JSON.
- No NaN, Infinity, undefined, duplicate keys, or insignificant semantic ordering.
- Arrays whose order is not semantic are sorted deterministically.
- Optional fields are omitted, not emitted as meaningless nulls.
- Large vectors, screenshots, crops, and raw DOM remain external refs.

### 9.2 Hash rules

`contentHash` covers all semantic fields except:

- `contentHash`;
- `snapshotId`;

Artifact refs must be stable logical IDs, not signed URLs.

### 9.3 Schema evolution

Schemas are closed with `additionalProperties: false`. Within a major:

- patch releases clarify constraints without changing accepted instances;
- minor releases may add optional standard fields only through explicit version negotiation and dual-schema compatibility tests;
- vendor or experimental data uses the namespaced top-level `extensions` object;
- unknown standard fields are rejected by strict validators;
- enum additions require a new minor and an explicit fallback policy in consumers;
- semantics of existing fields cannot change.

Major bump required for:

- removing/renaming required fields;
- changing types or identity/hash semantics;
- changing coordinate conventions;
- changing ref scope;
- changing edge direction semantics.

The July 12, 2026 ref-scope correction remains schema `1.0.0` because R0 has not
frozen or promoted a consumer fixture and the previous circular rule could not
produce a conforming snapshot. Once R0 freezes this corrected identity contract,
any subsequent hash or ref-scope semantic change requires a new major.

Reader compatibility:

- support current major and one prior major during rollout;
- migrations produce a new snapshot/hash and record source schema version;
- never mutate a stored historical blob in place.

## 10. View Contract

```ts
type UIGraphViewSpec = {
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
```

`focus` and `patchContext` require at least one ref. `diff` requires a comparison snapshot ID and content hash.

```ts
type UIGraphView = {
  schemaVersion: string;
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

type EvidenceRequest = {
  requestId: string;
  kind: "crop" | "full_screenshot" | "marked_overlay";
  sourceArtifactRef: string;
  coordinateSpaceId: string;
  rect?: Rect;
  elementRefs: string[];
  reason: string;
  priority: number;
};
```

`schemas/ui-graph-view.schema.json` is normative. `specHash` covers the normalized view spec, including renderer and tokenizer profiles. `viewId` is derived from `(snapshotContentHash, specHash)`. The rendered text is deterministic for that tuple.

A view with non-zero estimated visual tokens must name the visual-token profile used for the estimate.

### 10.1 Common rendering rules

- Page-derived text is delimited and labeled `UNTRUSTED_UI_CONTENT`.
- Facts include source/confidence when uncertainty matters.
- Refs always include snapshot ID context.
- Repeated items are summarized before unrelated high-salience nodes are dropped.
- Evidence requests identify why pixels are needed.
- The renderer must not emit instructions allegedly found in page content as system guidance.

### 10.2 View policies

`summary`:

- major regions, hierarchy, high-salience text, affordance counts, page-health warnings;
- no dense relation list.

`violations`:

- authoritative deterministic drift first;
- non-canonical/advisory matches clearly separated;
- include observed/canonical/delta/ref/evidence requirement.

`focus`:

- target nodes;
- ancestors to region root;
- labels/controls;
- bounded children;
- nearest relevant siblings;
- related DNA facts;
- default fewer than 30 nodes.

`actionMap`:

- visible interactive refs, role/name/state/rect;
- perception only; no action commands.

`patchContext`:

- ref, route, viewport, component-family candidate, style/token facts, selector hints, and evidence refs;
- no generated source patch.

`diff`:

- matched/added/removed/ambiguous nodes;
- changed semantic/style/geometry/DNA facts;
- separate capture instability from product change.

## 11. Saliency and Crop Selection

UI Graph may rank evidence regions using deterministic signals:

- requested refs and their local neighborhood;
- violation severity/confidence;
- source disagreement;
- small target size or dense overlap;
- parser-only provenance;
- text-over-image, occlusion, or stacking complexity;
- large visual change between snapshots.

It may consume an externally supplied saliency score but must record provider provenance.

Crop policy:

- prefer one padded local crop over a full screenshot;
- include enough neighboring context to disambiguate;
- avoid merging distant targets into an unreadable crop;
- request a Set-of-Mark overlay only when a model/consumer profile has demonstrated benefit;
- preserve an unmarked crop ref for audit.

## 12. Delta Contract

`UIGraphDelta` is validated by `schemas/ui-graph-delta.schema.json`.

```ts
type UIGraphDelta = {
  schemaVersion: string;
  deltaId: string;
  baseSnapshotSchemaVersion: string;
  baseSnapshotId: string;
  baseContentHash: string;
  targetSnapshotSchemaVersion: string;
  targetSnapshotId: string;
  targetContentHash: string;
  sequence: number;
  operations: UIGraphDeltaOperation[];
  createdAt: string;
};
```

Operations:

- `replace_header`
- `upsert_node`
- `remove_node`
- `upsert_edge`
- `remove_edge`
- `upsert_region`
- `remove_region`
- `replace_dna_projection`
- `replace_metrics`
- `replace_warnings`

Apply rules:

1. Base ID and hash must match.
2. Base and target snapshot schema majors must match the supported delta major.
3. `replace_header` replaces `build`, `source`, and `coordinateSpaces`; it is required when any of those fields differ.
4. Operations apply in listed order to ID-keyed maps.
5. Removing a node also requires explicit removal of incident edges in the same delta; implicit cascade is forbidden.
6. The applier sets the target schema version and target snapshot ID from the envelope.
7. Result validates against the target snapshot schema.
8. Recomputed content hash must equal `targetContentHash`.
9. Failure returns no partial target.

Deltas are not chained indefinitely. Judgment Engine chooses checkpoint frequency; a full target snapshot remains stored canonically.

## 13. Storage and Index Contract

Recommended MVP:

- canonical snapshot JSON in Judgment Engine object storage;
- metadata row keyed by tenant/repo/route/viewport/capture/hash;
- optional compressed blob;
- optional derived in-memory/spatial/text index regenerated from the blob;
- view cache keyed by `(snapshotHash, specHash)`.

Do not store signed evidence URLs in the snapshot. Resolve logical refs through Judgment Engine authorization.

Recommended cache key:

```text
capture_id:capture_schema:capture_version:dna_version_or_none:
builder_version:relation_policy:dna_projection:redaction_policy:options_hash
```

Graph database migration trigger:

- cross-snapshot traversal becomes a primary workload;
- derived indexes cannot meet p95 targets;
- operational cost is lower after including service, backup, tenancy, and migration overhead.

## 14. Metrics

```ts
type UIGraphMetrics = {
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
```

Views add tokenizer/model-profile estimates. Evaluation computes:

- text and visual tokens;
- compression ratio;
- grounding Recall@1/IoU;
- valid-ref rate;
- high-confidence lineage precision/coverage;
- finding precision/recall/severity agreement;
- crop sufficiency;
- total latency and cost per accepted finding/fix.

Build diagnostics returned outside the snapshot include per-stage timings, peak memory, canonical/compressed bytes, and implementation-specific counters. They are never part of `contentHash`.

## 15. Benchmark Protocol

### 15.1 Baselines

- B0: full screenshot + raw DOM/layout/style context.
- B1: AX snapshot only.
- B2: screenshot only.
- B3: screenshot + AX.
- B4: canonical full graph serialized without focus.
- B5: task-focused UI Graph view with selective crops.

All baselines use:

- identical frozen captures;
- identical UI-DNA version;
- identical model/prompt where applicable;
- model-native accounting for image tokens;
- repeated runs and confidence intervals for stochastic model outputs.

Required calculations:

```text
text_reduction = 1 - (view_text_tokens / baseline_text_tokens)
input_cost_reduction = 1 - (view_model_input_usd / baseline_model_input_usd)
grounding_retention = view_grounding_recall_at_1 / best_baseline_grounding_recall_at_1
```

Do not add text and visual tokens across model families as if they were interchangeable. Report model-native token counts and estimated USD separately. Use paired fixtures, bootstrap 95% confidence intervals, and publish per-cohort results for dense, long-page, non-DOM, responsive, and injection cases.

### 15.2 Representation-only tests

- deterministic output hash across repeated builds;
- schema and migration compatibility;
- node/edge growth;
- build/query latency;
- delta reconstruction;
- ref resolution and lineage;
- coordinate transform accuracy;
- redaction and adversarial input handling.

### 15.3 End-to-end tests

Judgment Engine owns execution. UI Graph changes are promoted only if:

- PRD quality/token/security gates pass;
- blocker recall does not regress;
- no source/version cohort shows a hidden failure masked by aggregate averages.

## 16. Failure Modes

| Failure | Required result |
|---|---|
| Screenshot missing | Build structured graph; mark visual evidence unavailable |
| DOM/layout missing but parser observations exist | Build parser-backed partial graph with explicit provenance |
| No structured or parser element evidence | Emit document-level partial graph; do not invent elements |
| AX and DOM disagree | Keep both claims; lower confidence; flag conflict |
| Computed styles missing | Structural graph; DNA style projection `unknown` |
| UI DNA missing | Neutral graph; no drift claims |
| Non-approved UI DNA supplied to a production build | Reject input |
| Authorized non-canonical UI-DNA eval fixture | Build only in offline/shadow mode; all matches non-authoritative |
| Node cap exceeded | Summarize repeated/low-salience regions; report truncation |
| Edge cap exceeded | Drop lowest-value non-structural edges; never drop required hierarchy |
| Coordinate transform invalid | Reject affected visual claims; do not emit misleading crops |
| Ref used with wrong snapshot | Typed `stale_or_foreign_ref` error |
| Delta base mismatch | Reject entire delta |
| Derived provider version missing | Reject derived observation |
| Sensitive text detected after redaction stage | Fail closed for prompt rendering |

## 17. Threat and Privacy Model

### 17.1 Assets

- screenshots/crops and visible customer data;
- DOM/AX text and attributes;
- UI-DNA rules and exceptions;
- tenant/repo identity;
- source linkage and selector hints;
- graph blobs, deltas, and cached views.

### 17.2 Threats and controls

| Threat | Control |
|---|---|
| Indirect/visual prompt injection | Mark all page text untrusted; preserve provenance; strip instruction-like control syntax from renderers; security eval fixtures |
| Hidden DOM poisoning | Visibility/paint evidence; hidden nodes excluded unless explanatory; source conflict flags |
| OCR/parser hallucination | Provider confidence; no silent override; parser-only flag; optional crop audit |
| Selector confusion/stale refs | Snapshot scoping; confidence matching; abstention; wrong-snapshot rejection |
| Cross-tenant evidence access | Logical artifact refs resolved only by Judgment Engine tenant authorization |
| PII/secret leakage | Upstream redaction metadata; sensitivity labels; fail-closed prompt rendering; retention inherited from Judgment Engine |
| Oversized graph denial of service | Input/node/edge/text limits; bounded relations; streaming validation where implemented |
| Delta corruption/replay | Base/target hashes, sequence, schema validation, immutable checkpoints |
| Malicious numeric/geometry values | finite/range validation; transform validation; reject NaN/Infinity/overflow |
| Embedding privacy leakage | Store vector refs only; provider/version; tenant-scoped retrieval outside UI Graph |

UI Graph never logs raw sensitive text by default. Metrics use counts/hashes, not content.

## 18. Implementation Milestones

### M0 — Contracts and fixtures

- Schemas, compatibility tests, canonicalization/hash rules.
- Cross-repo golden read-profile fixtures.
- Frozen eval manifests.

### M1 — Deterministic structured graph

- DOM/layout + AX fusion.
- Coordinates, refs, hierarchy, bounded relations, metrics.
- Summary/focus views.

### M2 — UI-DNA projection

- Exact/tolerance token and scale matches.
- Approved exceptions and non-canonical evaluation behavior.
- Violations/patchContext views.

### M3 — Diffs, lineage, and deltas

- Cross-snapshot matcher with abstention.
- Diff view and typed delta protocol.
- Pointer-oriented benchmark.

### M4 — Optional observations

- Parser/OCR/embedding/learned-relation ingestion.
- Source disagreement and visual-evidence escalation.
- No provider inference inside UI Graph.

### M5 — Shadow and rollout

- Judgment Engine integration and storage indexes.
- Baseline comparison, feature flags, rollback.

## 19. Acceptance Criteria

The specification is implementable when:

- both schemas validate their golden fixtures;
- repeated builds produce the same content hash;
- wrong-snapshot refs and wrong-base deltas fail closed;
- no persisted graph operation requires model or browser access;
- UI-DNA ownership and approval state remain external;
- views stay within requested budgets or explicitly report truncation;
- every externally supplied learned fact is provenance-labeled;
- representation and end-to-end promotion gates are automated in Judgment Engine.
