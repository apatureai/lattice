# Apature UI Graph - Product Requirements Document

Created: 2026-06-16
Status: shared perception-layer specification
Canonical company context: `apatureai/core`
Primary consumers: `apatureai/gate`, `apatureai/mcp-review`, `apatureai/pointer`, `apatureai/interactive-review`
Shared technical substrate: `apatureai/judgment-engine`

## 1. One-Line Pitch

Apature UI Graph is the compact, UI-DNA-aware scene graph that lets Apature judges and agents understand rendered product UI with fewer tokens, better element grounding, and stronger design-system context.

## 2. Why This Exists

AI coding agents can generate frontend screens quickly, but they still struggle to inspect the result the way a product engineer or designer would. Existing browser-agent tools expose accessibility snapshots, DOM structure, screenshots, and natural-language browser actions. Those are useful, but they do not encode the product-specific design judgment Apature needs.

Apature already has the inputs:

- Rendered screenshots from `judgment-engine`.
- DOM geometry and accessibility structure.
- Computed style facts.
- Repo context and component hints.
- UI DNA from the team's actual product and design system.
- Feedback from Gate reviews and agent fix loops.

UI Graph turns those inputs into a reusable representation that every Apature surface can share.

## 3. Target Users

Internal product consumers:

- Gate, for cheaper and more grounded PR review prompts.
- MCP Review, for agent-readable evidence and patch hints.
- Pointer, for live element references and design-drift callouts.
- Interactive Review, for future exploration without losing the no-write philosophy.

Future external users:

- Agent developers building UI-focused coding workflows.
- Design-system teams that want a machine-readable map of rendered UI drift.

Economic buyer:

- Not defined for the MVP. This is first an infrastructure moat for Gate and agent surfaces.

## 4. Product Promise

UI Graph must answer five questions about a rendered screen:

1. What elements are visible?
2. How are they spatially and semantically related?
3. Which product/design-system facts describe them?
4. Which parts drift from this repo's UI DNA?
5. What is the smallest grounded prompt view a judge or agent needs next?

The product returns references, facts, graph neighborhoods, and optional visual evidence. It never clicks, types, publishes comments, or edits code.

## 5. MVP Scope

In scope:

- `UIGraphSnapshot` schema.
- Builder interface from `CaptureBundle` and `UIDNASnapshot`.
- Node extraction from DOM geometry, accessibility tree, computed styles, text, and screenshot metadata.
- Edge construction for containment, alignment, proximity, reading order, label/control relations, and component-family similarity.
- UI-DNA projection onto nodes and regions.
- Prompt views: `summary`, `violationsOnly`, `focus`, `actionMap`, and `patchHints`.
- Evidence references: element refs, selector hashes, screenshot crop refs, and marked overlay refs.
- Metrics: graph size, prompt token estimate, compression ratio, valid-ref rate, and confidence.

Out of scope:

- Browser automation and action execution.
- Code modification.
- GitHub delivery.
- Full visual regression testing.
- Replacing `judgment-engine`.
- Replacing the canonical UI-DNA repo.
- Broad desktop computer-use automation.

## 6. Core User Flow

1. `judgment-engine` captures a route, viewport, screenshot, DOM geometry map, accessibility snapshot, computed style facts, and page-health metadata.
2. `ui-dna` provides the current design genome for the repo.
3. A consumer requests a graph build for a route and viewport.
4. UI Graph normalizes visible nodes, merges duplicate observations, and assigns stable element refs.
5. UI Graph adds spatial, semantic, and design-system edges.
6. UI Graph projects UI-DNA rules and known component families onto nodes and regions.
7. A consumer requests a prompt view.
8. The model receives compact graph facts plus optional crops only for ambiguous or high-value areas.

## 7. Interfaces

Primary build interface:

```ts
buildUiGraph(
  capture: CaptureBundle,
  dna: UIDNASnapshot,
  options: UIGraphBuildOptions
) -> UIGraphSnapshot
```

Primary query interfaces:

```ts
queryUiGraph(snapshotId, query) -> UIGraphView
renderPromptView(snapshotId, viewSpec) -> string
getEvidence(snapshotId, evidenceRef) -> EvidenceArtifact
```

Default consumer behavior:

- Gate uses `violationsOnly` and `patchHints` to reduce review prompt size.
- MCP Review uses `focus` to help coding agents repair a specific finding.
- Pointer uses element refs, rects, and overlay metadata.
- Interactive Review uses `actionMap` only as perception context; action execution remains outside this repo.

## 8. Success Metrics

Token efficiency:

- Reduce average prompt tokens versus raw screenshot-plus-DOM context for the same review.
- Track crop-on-demand usage versus full-image usage.

Grounding:

- Valid element-reference rate.
- Correct node selection for known UI issues.
- Screenshot crop coverage for cited refs.

Judgment:

- Finding precision on Gate reviews when graph views are used.
- Reduction in generic findings.
- Increase in accepted or fixed findings.

Agent utility:

- Agent fix success rate after receiving `focus` or `patchHints`.
- Number of follow-up perception calls needed per fix.
- Time from finding to verified correction.

## 9. Sequencing

Build order:

1. Define schemas and prompt-view contract.
2. Implement graph builder against existing capture artifacts.
3. Add graph metrics and local golden fixtures.
4. Integrate Gate review prompts behind a feature flag.
5. Add MCP Review `focus` and `patchHints`.
6. Add optional visual-parser fallback for DOM/accessibility gaps.
7. Feed accepted/rejected findings into graph ranking and UI-DNA memory.

UI Graph should not block Gate MVP. It should begin as a lightweight internal representation and graduate only when it demonstrably improves cost, grounding, or fix success.

## 10. Risks

Representation risk:

- A graph that loses important visual nuance can make judgment worse. Mitigation: preserve evidence refs and use crops when confidence is low.

Scope risk:

- The repo can drift into a browser agent. Mitigation: no action execution, no customer workflow automation, no GitHub delivery.

Data-quality risk:

- DOM, accessibility, and computed style facts can disagree. Mitigation: source-specific confidence and explicit evidence provenance.

Latency risk:

- Graph construction adds work before the model call. Mitigation: cache by `(repo, route, viewport, head_sha, dna_version, capture_version)` and ship prompt views that reduce downstream model cost.

Competition risk:

- Generic browser-agent tools may add compact snapshots. Mitigation: UI-DNA projection, design-specific edges, feedback-trained ranking, and integration with Apature's neutral review surfaces.

## 11. Repository Boundary

This repo owns:

- UI graph schema and prompt-view contracts.
- Graph-construction algorithm requirements.
- Token and grounding metrics.
- Evidence reference model.
- Research and architecture for Apature's representation layer.

This repo does not own:

- Browser capture and screenshot storage.
- Qwen3-VL calls.
- Review scheduling.
- GitHub comments or Check Runs.
- Customer billing.
- UI-DNA canonical extraction.
- Product surfaces such as Gate, Pointer, and MCP Review.
