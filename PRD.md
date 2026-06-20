# Apature UI Graph — Product Requirements

Created: 2026-06-16
Revised: 2026-06-18
Status: build-ready representation-layer specification
Canonical company context: `apatureai/core`
Capture, inference, eval execution, and artifact owner: `apatureai/judgment-engine`
Canonical design-genome owner: `apatureai/ui-dna`

## 1. Product Definition

Apature UI Graph is a token-efficient, UI-DNA-aware representation of rendered product UI. It gives Apature judges and agents a compact, auditable map of visible elements, layout, accessibility semantics, style facts, design-system matches, evidence, and uncertainty.

It is infrastructure for Apature products, not a buyer-facing browser agent.

## 2. Problem

Judgment Engine can capture screenshots, DOM geometry, accessibility data, and computed styles. UI DNA can describe the product’s approved design language. Sending all of those artifacts directly to a model on every review creates four problems:

- high text and visual-token cost;
- weak and inconsistent element references;
- repeated parsing of the same rendered state;
- loss of provenance when facts from pixels, DOM, accessibility, and UI DNA disagree.

Accessibility-only context is cheaper but omits rendered style and visual hierarchy. Screenshot-only context captures rendered truth but is expensive, harder to redact, and less directly linked to code and design tokens.

UI Graph exists to preserve the useful information from both while returning only the task-relevant subset.

## 3. Product Promise

For a rendered route and viewport, UI Graph must answer:

1. What visible elements and regions exist?
2. What semantic, spatial, style, and affordance facts are supported by evidence?
3. Which facts match or drift from the supplied UI-DNA version?
4. Which element reference can a consumer cite without inventing a selector?
5. What is the smallest view that preserves enough evidence for the current judgment or repair task?
6. What changed from a prior graph, and how certain is the cross-snapshot match?

## 4. Users and Consumers

Primary internal consumers:

- Judgment Engine: graph construction orchestration, persistence, prompt assembly, and eval execution.
- Gate: graph-backed design-review findings and evidence.
- MCP Review: focused evidence and repair context.
- Pointer: live refs, geometry, and deltas.
- Interactive Review: read-only perception context for declared flows.

Future consumers:

- Entropy Engine: rendered divergence evidence.
- Source of Truth: references to approved rendered examples.
- Internal dataset and analysis jobs operating through Judgment Engine.

## 5. Scope

### 5.1 In scope

- Machine-readable `UIGraphSnapshot`, `UIGraphView`, and `UIGraphDelta` contracts.
- Deterministic fusion of supplied DOM/layout, accessibility, computed-style, text, screenshot-coordinate, and optional parser observations.
- Snapshot-local opaque element references.
- Ranked locator hints and cross-snapshot matching with confidence and abstention.
- Bounded structural, semantic, and spatial relations.
- Deterministic UI-DNA token, scale, component, and rule projection.
- Query-time focused views.
- Evidence references and coordinate transforms for crops and overlays.
- Representation metrics and frozen fixtures used by Judgment Engine’s eval harness.
- Redaction, sensitivity labels, untrusted-content boundaries, and provenance.

### 5.2 Out of scope

- Browser navigation, capture, readiness, screenshots, or DOM extraction.
- OCR, screen parsing, visual embeddings, learned relation inference, or VLM calls.
- Browser actions, code modifications, commits, or GitHub delivery.
- UI-DNA extraction, approval, canonical storage, or schema ownership.
- Feedback collection, preference-data storage, per-repo memory, or model training.
- Running the company-wide evaluation or model/prompt promotion system.
- A general-purpose graph database or browser automation API.

## 6. Required Product Behaviors

### 6.1 Build a source-fused snapshot

Given a versioned capture bundle and optional UI-DNA graph projection, UI Graph must:

- normalize coordinates into explicit document, viewport, frame, and evidence-image spaces;
- merge observations only when the evidence supports the match;
- retain conflicting values with source-specific confidence;
- omit hidden/layout-only nodes unless they explain visible structure;
- create regions for meaningful layout containers and repeated structures;
- cap relation density and repeated-list expansion;
- emit a canonical, content-hashed snapshot.

### 6.2 Provide honest references

- `elementRef` is valid only within its snapshot.
- Consumers must not treat `elementRef` as a CSS selector or browser handle.
- Every reference resolves to geometry and at least one evidence source.
- Cross-snapshot identity is a match result, never an unconditional stable ID.
- A low-confidence match must abstain rather than point to the wrong element.

### 6.3 Project UI DNA without taking ownership

UI Graph may determine that an observed value exactly or approximately matches a supplied UI-DNA token, scale, component, or rule. It must include:

- the UI-DNA version, projection schema, content digest, source state, and use mode;
- observed and canonical values;
- match method and tolerance;
- confidence and provenance;
- `unknown` when the supplied DNA is absent or insufficient.

UI Graph must not mutate, approve, or extend UI DNA. Production conformance claims require an approved projection.

### 6.4 Render task-focused views

Required views:

- `summary`: page regions, hierarchy, major affordances, page-health caveats.
- `violations`: UI-DNA drift and deterministic violations, ranked and budgeted.
- `focus`: bounded graph neighborhood around one or more refs.
- `actionMap`: visible interactive elements as perception context only.
- `patchContext`: minimal facts useful to a coding agent, without generating a patch.
- `diff`: matched, added, removed, and changed nodes between snapshots.

Every view must report truncation, omitted evidence, token estimates, and the policy/version that produced it.

### 6.5 Escalate pixels selectively

UI Graph can recommend evidence crops or overlays when:

- the fact is inherently visual;
- sources disagree;
- target density or size makes coordinate grounding ambiguous;
- a node has only parser/pixel provenance; or
- the requested task explicitly requires visual comparison.

Judgment Engine decides whether to fetch or send the artifact.

## 7. Success and Promotion Gates

All gates are measured on a frozen, content-addressed capture set through Judgment Engine.

### 7.1 Token and cost efficiency

- At least 70% reduction in total model input tokens versus the current screenshot-plus-raw-structure baseline for common Gate reviews.
- `focus` p95 at or below 1,500 text tokens before optional image evidence.
- At least 60% reduction in repeated-review input cost when reusing the same snapshot for multiple queries.

### 7.2 Grounding and integrity

- Snapshot-local valid-reference rate at or above 99.5%.
- Grounding Recall@1 no worse than the best baseline by more than 1 percentage point.
- High-confidence cross-snapshot match precision at or above 98%; recall is secondary because abstention is allowed.
- Crop/overlay coordinate transform error at or below 2 CSS px or 0.5% of the shorter viewport dimension, whichever is larger.
- Delta reconstruction hash match at 100% for valid deltas.

### 7.3 Judgment retention

- No more than 2 percentage points loss in finding recall and 1 point loss in precision against the full-context baseline.
- No regression in blocker recall.
- No increase in unknown/invalid element refs in published findings.

### 7.4 Performance

Initial build SLO hypothesis, subject to benchmark confirmation:

- p95 deterministic build overhead ≤300 ms for 1,000 normalized nodes.
- p95 focused-view query ≤50 ms from a loaded snapshot.
- bounded graph size: O(n) persisted edges with a configured maximum degree.

Optional upstream OCR, parser, embedding, or VLM latency is excluded and reported separately.

### 7.5 Security and privacy

- No cross-tenant artifact/reference resolution.
- Redaction fixtures produce zero configured secret/PII leaks in serialized prompt views.
- Untrusted visible or DOM text is always serialized as data, never instructions.
- Malformed or adversarial deltas cannot produce a hash-valid snapshot.

## 8. Evaluation Datasets

UI Graph defines representation manifests and labels; Judgment Engine runs the evaluation.

### 8.1 Internal frozen sets

- `ug-core`: representative routes across clean, drifted, responsive, dense, and long-page layouts.
- `ug-lineage`: before/after captures with insertions, reorderings, text edits, component replacement, and responsive changes.
- `ug-nondom`: canvas, SVG, image-only, shadow-heavy, and custom-control screens with optional parser observations.
- `ug-dna`: exact token matches, tolerance matches, intentional exceptions, ambiguous families, and unapproved DNA.
- `ug-security`: hidden text, visual prompt injection, oversized content, PII, malicious labels, and cross-tenant refs.
- `ug-delta`: mutation sequences with canonical target hashes.

Each fixture must record capture version, browser version, viewport, graph builder version, UI-DNA version, redaction policy, and license/consent status.

### 8.2 External diagnostic sets

Where licenses allow:

- Mind2Web/BrowserGym fixtures for observation-size and element-candidate comparisons.
- VisualWebArena tasks for visually dependent cases.
- ScreenSpot and ScreenSpot-Pro for coordinate-grounding diagnostics.
- ScreenParse-style dense labels for parser-observation coverage.

External sets are diagnostics, not substitutes for Apature design-review evaluation.

## 9. Rollout

### R0 — Contract and fixture freeze

- Approve ownership boundaries and schemas.
- Create frozen capture/DNA fixture manifests.
- Validate canonical hashing, version evolution, and reference semantics.

### R1 — Offline representation benchmark

- Build graphs from existing capture artifacts.
- Compare AX-only, screenshot-only, raw hybrid, and graph-view baselines.
- Do not change production prompts.

Exit: token, quality, grounding, latency, and security gates are met or explicitly rejected.

### R2 — Judgment Engine shadow integration

- Build and store graph snapshots in parallel.
- Render views but do not use them for published findings.
- Compare graph-backed and current prompts on identical captures.

Exit: no integrity regression; cost/quality benefit survives real traffic.

### R3 — Gate feature flag

- Enable `violations` and `patchContext` for a small tenant cohort.
- Full screenshot/raw context remains available as a fallback.
- Roll back on grounding, blocker-recall, or latency regression.

### R4 — MCP Review and Pointer

- Expose `focus`, `diff`, and typed deltas.
- Measure successful fixes, recheck calls, delta corruption, and stale-ref failures.

### R5 — Optional learned observations

- Admit parser, embedding, or learned relation observations only after deterministic hybrid value is proven.
- Each provider needs an independent version, calibration report, security review, and experiment gate.

## 10. Dependencies and Cross-Repo Contracts

### Judgment Engine provides

- authorized capture artifact access;
- versioned DOM/layout, AX, style, text, page-health, and redaction metadata;
- optional OCR/parser/embedding observations;
- storage, tenancy, retention, encryption, model calls, eval execution, and metrics export.

### UI DNA provides

- an approved, immutable `GraphProjection` by default;
- projection schema version, source DNA version, content digest, and source state;
- tokens, semantic roles, component families, distributions, rules, exceptions, confidence, and provenance;
- separately authorized non-canonical fixtures only for offline/shadow evaluation.

### UI Graph returns

- content-addressed graph snapshot and metrics;
- task-focused views and evidence requirements;
- typed deltas and cross-snapshot match results;
- no findings authored by a model, browser actions, or code patches.

### Product consumers receive

Only the view or refs needed for their workflow. They must not depend on UI Graph implementation internals or access another tenant’s graph/evidence directly.

## 11. Product Risks

| Risk | Required response |
|---|---|
| Graph drops visually important nuance | Preserve evidence refs; evaluate against full context; escalate crops |
| Fusion produces false certainty | Store conflicting observations and source confidence; allow `unknown` |
| “Stable” refs point to the wrong element | Snapshot scope, confidence thresholds, abstention, lineage fixtures |
| Edge explosion defeats compression | Bounded degree, query-time similarity, repeated-region summaries |
| UI DNA canonizes existing drift | Production accepts approved projections only; non-canonical eval data can never yield authoritative matches |
| Optional learned facts become hidden authority | Provider/version provenance; advisory status; independent calibration |
| Page text attacks downstream models | Treat all page content as untrusted data; redaction and injection fixtures |
| Repo becomes a browser agent | No capture, actions, sessions, model calls, or customer workflow orchestration |

## 12. Non-Negotiable Invariants

- UI Graph is a perception/representation layer.
- Full snapshots are immutable and content-addressed.
- Large evidence remains behind authorized refs.
- No source silently overwrites another source.
- No reference claims cross-snapshot stability without a confidence score.
- UI DNA remains canonical outside this repo.
- Judgment Engine remains the owner of capture, inference, eval execution, security substrate, artifact storage, and memory.

## 13. Dependency Readiness

As of 2026-06-18:

- Judgment Engine’s checked-in `@engine/types` capture contract exposes images, selector geometry, and coarse page health. It does not yet expose the DOM/layout, AX, style, transform, redaction, and logical artifact-ref profile required by UI Graph.
- UI DNA defines the target ownership and projection boundary, but UI Graph integration must wait for a published, versioned `GraphProjection` contract; sibling draft documentation is not a production dependency.
- `apatureai/core` establishes the rendered-judgment and no-write product boundary but does not own UI Graph wire details.

R0 is blocked until cross-repo golden fixtures prove the producer contracts rather than only documenting them.
