# Apature UI Graph - Technical Requirements Document

Created: 2026-06-16
Status: build-ready technical specification

## 1. Technical Summary

UI Graph builds a compact representation of a rendered UI from existing Apature artifacts. It consumes capture output from `judgment-engine` and design context from `ui-dna`, then emits a `UIGraphSnapshot` plus prompt views for Gate, MCP Review, Pointer, and future agent surfaces.

Primary interface:

```ts
buildUiGraph(captureBundle, uiDnaSnapshot, options) -> UIGraphSnapshot
```

Primary requirement:

The graph must be small enough for routine model prompts, grounded enough to point back to visible pixels, and rich enough to express design-system drift.

## 2. Inputs

`CaptureBundle` is owned by `judgment-engine`.

Minimum required fields:

```ts
type CaptureBundle = {
  captureId: string;
  repo: RepoRef;
  route: string;
  viewport: ViewportRef;
  headSha?: string;
  screenshot: {
    imageRef: string;
    width: number;
    height: number;
  };
  domGeometry: DomGeometryNode[];
  accessibilityTree?: AccessibilityNode[];
  computedStyles?: ComputedStyleNode[];
  textRuns?: TextRun[];
  pageHealth: PageHealth;
  captureVersion: string;
};
```

`UIDNASnapshot` is owned by `ui-dna`.

Minimum required fields:

```ts
type UIDNASnapshot = {
  dnaVersion: string;
  tokens: DesignTokenIndex;
  componentFamilies: ComponentFamilyIndex;
  spacingScale: ScaleIndex;
  typographyScale: TypographyIndex;
  colorPolicy: ColorPolicy;
  layoutRules: LayoutRule[];
  brandNotes?: string;
};
```

## 3. Output Schema

```ts
type UIGraphSnapshot = {
  id: string;
  repo: RepoRef;
  route: string;
  viewport: ViewportRef;
  headSha?: string;
  dnaVersion: string;
  captureVersion: string;
  buildVersion: string;
  nodes: UIGraphNode[];
  edges: UIGraphEdge[];
  regions: UIRegion[];
  violations: UIDesignViolation[];
  promptViews: UIPromptViewIndex;
  metrics: UIGraphMetrics;
};
```

```ts
type UIGraphNode = {
  id: string;
  elementRef: string;
  role: string | null;
  label: string | null;
  text: string | null;
  rect: Rect;
  visibility: "visible" | "partial" | "hidden";
  affordances: UIAffordance[];
  visual: {
    componentGuess?: string;
    colorTokens: TokenMatch[];
    spacing: ScaleMatch[];
    typography: TypographyFacts;
    layer?: number;
  };
  dna: {
    status: "matches" | "drifts" | "unknown";
    rules: string[];
    confidence: number;
  };
  evidence: {
    sources: EvidenceSource[];
    cropRef?: string;
    overlayRef?: string;
    selectorHash?: string;
  };
  confidence: number;
};
```

```ts
type UIGraphEdge = {
  id: string;
  from: string;
  to: string;
  kind:
    | "contains"
    | "adjacent_to"
    | "aligned_with"
    | "overlaps"
    | "labels"
    | "controls"
    | "same_component_family"
    | "flows_to"
    | "visually_groups";
  weight: number;
  evidence: EvidenceSource[];
};
```

## 4. Build Pipeline

1. Ingest `CaptureBundle` and `UIDNASnapshot`.
2. Normalize DOM geometry into candidate visual nodes.
3. Merge accessibility facts by role, label, text, and bounding box overlap.
4. Merge computed style facts by element identity and selector hash.
5. Remove hidden, duplicate, and layout-only nodes unless they explain visible structure.
6. Generate stable `elementRef` values.
7. Add spatial edges: containment, proximity, alignment, overlap, and reading order.
8. Add semantic edges: label/control, component-family similarity, and navigation flow.
9. Project UI-DNA rules onto nodes and regions.
10. Create evidence refs for screenshots, crops, overlays, and source nodes.
11. Emit prompt views and metrics.

Optional visual parser fallback:

- Run only when DOM/accessibility confidence is low or the screen contains canvas, image-only UI, screenshots, custom controls, or shadow-heavy surfaces.
- Treat visual-parser detections as candidate nodes with explicit provenance.
- Never let visual detections silently override higher-confidence DOM/accessibility evidence.

## 5. Prompt Views

Prompt views are lossy, task-specific renderings of the graph.

`summary`:

- Route, viewport, major regions, key affordances, and page-health warnings.

`violationsOnly`:

- Nodes and regions with UI-DNA drift, sorted by severity, confidence, and likely user impact.

`focus`:

- Graph neighborhood around one or more `elementRef` values.
- Includes nearby labels, parent region, children, sibling spacing, token matches, and evidence refs.

`actionMap`:

- Clickable, input, link, scroll, hover, and focusable affordances.
- Used only as perception context for agent surfaces.

`patchHints`:

- Minimal element facts needed by a coding agent: component guess, selector hash, design-token mismatch, spacing delta, text/label, route, viewport, and screenshot crop refs.

## 6. Token Budgeting

Every prompt view must report:

```ts
type TokenBudget = {
  estimatedTokens: number;
  baselineTokens: number;
  compressionRatio: number;
  includedNodes: number;
  includedEdges: number;
  includedCrops: number;
};
```

Targets for MVP:

- `violationsOnly` should stay under 25 percent of the equivalent raw DOM-plus-screenshot context for common PR reviews.
- `focus` should include fewer than 30 nodes unless explicitly expanded.
- Full screenshots should be referenced, not embedded, unless the consumer requests visual evidence.

## 7. API Surface

Build:

```ts
type BuildUiGraph = (
  capture: CaptureBundle,
  dna: UIDNASnapshot,
  options?: UIGraphBuildOptions
) => Promise<UIGraphSnapshot>;
```

Query:

```ts
type QueryUiGraph = (
  snapshotId: string,
  query: UIGraphQuery
) => Promise<UIGraphView>;
```

Prompt rendering:

```ts
type RenderPromptView = (
  snapshotId: string,
  viewSpec: PromptViewSpec
) => Promise<string>;
```

Evidence:

```ts
type GetEvidence = (
  snapshotId: string,
  evidenceRef: string
) => Promise<EvidenceArtifact>;
```

## 8. Storage And Cache

Recommended cache key:

```text
repo:route:viewport:head_sha:dna_version:capture_version:build_version
```

Storage rules:

- Graph JSON can live in the shared artifact store.
- Large images remain in object storage owned by `judgment-engine`.
- Prompt views can be regenerated from graph JSON.
- Evidence refs must expire according to the shared retention policy.

Invalidation rules:

- New capture version invalidates graph snapshots.
- New UI-DNA version invalidates design projections.
- New head SHA invalidates PR-specific graphs.
- Build-version change invalidates all derived prompt views.

## 9. Security And Privacy

UI Graph inherits security boundaries from `judgment-engine`.

Requirements:

- Do not execute browser actions.
- Do not fetch arbitrary URLs.
- Do not store raw secrets found in text nodes.
- Redact configured sensitive selectors and text patterns before prompt rendering.
- Keep evidence provenance so consumers can audit why a node or violation exists.
- Treat prompt injection in visible UI text as untrusted content.

## 10. Evaluation

Golden fixtures:

- Clean component page.
- Page with off-scale spacing.
- Page with hard-coded non-token color.
- Mobile overflow.
- Canvas or image-heavy UI.
- Shadow DOM/custom-control page.

Metrics:

- Graph build latency.
- Nodes per viewport.
- Edge density.
- Prompt token estimate.
- Compression ratio.
- Valid `elementRef` rate.
- Crop coverage for cited nodes.
- UI-DNA drift precision.
- Agent fix success rate when `patchHints` is used.

## 11. MVP Milestones

Milestone 1: Schema and fixtures

- Define TypeScript/Zod schemas.
- Create three local capture fixtures.
- Render `summary` and `focus` views.

Milestone 2: Graph builder

- Normalize DOM/accessibility/computed-style artifacts.
- Generate stable refs and spatial edges.
- Add metrics.

Milestone 3: UI-DNA projection

- Map colors, spacing, typography, and component guesses onto graph nodes.
- Emit `violationsOnly` and `patchHints`.

Milestone 4: Gate integration

- Feature-flag graph-backed review prompts.
- Compare cost, finding precision, and valid-ref rate against the baseline.

Milestone 5: Agent integration

- Expose `focus` and `patchHints` to MCP Review.
- Measure agent fix success and follow-up perception calls.
