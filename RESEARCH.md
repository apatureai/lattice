# Apature UI Graph — Research and Design Synthesis

> **Archived research document.** A literature review written in mid-2026, preserved as
> written. Its links and claims are current as of the stated access dates and have not been
> revisited since. See [README.md](README.md) for what was actually built.

Created: 2026-06-16
Revised: 2026-06-18
Status: source-backed architecture recommendation

## 1. Research Question

What rendered-UI representation gives Apature the best grounding and design-system specificity per token without turning UI Graph into a browser agent, capture engine, model-serving layer, or second owner of UI DNA?

Recommendation:

> Build a deterministic hybrid scene graph from structured browser evidence, attach pixels by reference, and render task-focused views on demand. Use screenshot parsers, embeddings, and learned relations only as optional provenance-labeled observations supplied by Judgment Engine.

This is a stronger claim than “graphs are compact.” The design must beat accessibility snapshots, raw DOM/layout data, and screenshot-only perception on Apature tasks under measured token, latency, cost, and grounding constraints.

## 2. Evidence Quality

The literature is strong on three points:

1. Raw HTML/DOM observations are often too large for repeated agent use.
2. Accessibility snapshots are materially more compact and actionable than raw DOM but omit visual appearance and can still be very long.
3. Pixels contain information unavailable in text-only structures, while visual grounding remains imperfect and benefits from structured or region-focused assistance.

Evidence is weaker on the exact representation Apature needs:

- There is no accepted benchmark for UI-DNA-aware design review.
- Browser-agent task success does not directly measure design-finding precision.
- Model-side visual-token pruning results do not prove that a symbolic graph preserves typography, spacing, or visual hierarchy.
- Recent 2026 work on structured page memory, dense screen parsing, and GUI-specific token reduction is promising but still preprint evidence.

Therefore the architecture should preserve source evidence, support abstention, and make representation choices experimentally reversible.

## 3. Primary-Source Findings

### 3.1 Accessibility trees are the best structured baseline, not the final representation

[Playwright MCP](https://github.com/microsoft/playwright-mcp), accessed 2026-06-18, uses the accessibility tree instead of pixel input and describes its tool application as deterministic. The same official README also warns that accessibility snapshots can be verbose and positions more selective CLI/skill interfaces as more token-efficient for coding agents. This is direct evidence for AX as a strong baseline and for query-time focusing rather than full-tree prompting.

[Playwright ARIA snapshots](https://playwright.dev/docs/aria-snapshots) serialize accessible roles, names, attributes, and hierarchy. This is valuable semantic compression, but the representation is intentionally accessibility-oriented rather than a rendered-style model.

The [Chrome DevTools Protocol Accessibility domain](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/) exposes role, accessible name, description, state, parent/child relationships, and an associated backend DOM node when one exists. It also exposes ignored nodes and reasons, which matters when reconciling visible pixels with accessibility omissions.

Implication:

- AX is the default semantic spine.
- AX-only cannot represent spacing, paint order, occlusion, color, typography, visual grouping, canvas content, or UI-DNA drift.
- UI Graph must retain accessibility provenance rather than flattening AX into unqualified text.

### 3.2 DOM/layout evidence provides geometry and paint facts but is verbose and implementation-coupled

The [CDP DOMSnapshot domain](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/) can return a flattened DOM including frames, templates, imported documents, flattened shadow DOM, layout bounds, selected computed styles, DOM rectangles, paint order, stacking-context information, blended backgrounds, and text opacity.

[Mind2Web](https://arxiv.org/abs/2306.06070), first submitted 2023-06-09, reports that raw HTML from real websites is often too large for direct LLM use and improves effectiveness and efficiency by filtering candidate elements before the main model.

[MarkupLM](https://arxiv.org/abs/2110.08518), first submitted 2021-10-16, and [WebFormer](https://arxiv.org/abs/2202.00217), first submitted 2022-02-01, show that markup hierarchy and graph-like structural relations are useful inductive biases for web understanding. These papers support preserving structure; they do not establish that Apature should run a graph neural network in production.

[Graph4GUI](https://arxiv.org/abs/2404.13521), submitted 2024-04-21 and published at CHI 2024, represents GUI elements and layout constraints as a heterogeneous bipartite graph, then learns embeddings with a GNN for autocompletion, classification, and retrieval. It supports explicit alignment, same-size, grouping, and multimodal constraints as useful GUI structure. Its tasks and Enrico-style data do not establish value for rendered design review or prompt serialization.

Implication:

- DOM/layout is the geometric and provenance backbone.
- Raw DOM must not be the prompt format.
- Graph structure is justified as an inspectable representation; a GNN is not justified until an Apature task shows incremental value over deterministic traversal.
- Browser-internal node IDs are capture-local evidence IDs, not durable product identifiers.

### 3.3 Pixels are necessary for rendered truth, but screenshot-only perception is a costly default

[VisualWebArena](https://arxiv.org/abs/2401.13649), submitted 2024-01-24, demonstrates realistic web tasks whose solution requires visual information that text-only agents miss.

[WebVoyager](https://arxiv.org/abs/2401.13919), submitted in January 2024, uses screenshots as its primary observation and argues that DOM or accessibility serializations can be overly verbose.

[UI-TARS](https://arxiv.org/abs/2501.12326), submitted 2025-01-21, demonstrates that screenshot-native GUI agents can perform strongly across GUI benchmarks after large-scale GUI-specific training.

[OSWorld](https://arxiv.org/abs/2404.07972), submitted 2024-04-11, found large gaps between humans and multimodal agents and identified GUI grounding and operational knowledge as major failure sources.

Implication:

- Apature cannot assume that models need a symbolic graph to “see.”
- Screenshot-only perception should remain a comparison baseline and a fallback for non-DOM surfaces.
- Sending a full screenshot on every task wastes tokens when only a small region or deterministic style fact is relevant.

### 3.4 Hybrid grounding is better supported than either extreme

[SeeAct](https://arxiv.org/abs/2401.01614), submitted in January 2024, reports that its best web grounding strategy combines HTML text and visuals; Set-of-Mark-style image annotation alone underperformed its hybrid strategy on web-agent grounding.

[BrowserGym](https://arxiv.org/abs/2412.05467), submitted 2024-12-06, standardizes multimodal browser observations including HTML, accessibility trees, and rendered pixels, reflecting the field’s need to compare and combine modalities.

[WorkArena](https://arxiv.org/abs/2403.07718), submitted 2024-03-12, similarly exposes HTML, AX, and pixels through BrowserGym for enterprise web tasks.

[AgentOccam](https://arxiv.org/abs/2410.13825), submitted 2024-10-17 and published at ICLR 2025, shows that careful observation/action-space design alone can materially improve web-agent results. This is evidence that representation quality can matter as much as adding orchestration complexity.

Implication:

- The default Apature representation should fuse sources and preserve disagreements.
- A source should win only for the fact it is competent to establish: AX for accessible semantics, DOM/layout for geometry and style linkage, pixels for rendered appearance, UI DNA for canonical design intent.

### 3.5 Screen parsing is a useful gap filler, not the canonical source

[OmniParser](https://arxiv.org/abs/2408.00203), submitted 2024-08-01, combines interactable-region detection and semantic captioning to convert screenshots into structured UI elements and improves grounding benchmarks.

[ScreenAI](https://arxiv.org/abs/2402.04615), first submitted in February 2024, trains a vision-language model specialized for UI and infographic understanding with flexible image patching.

[Pix2Struct](https://arxiv.org/abs/2210.03347), submitted in October 2022, uses screenshot parsing as a pretraining objective for visually situated language.

[ScreenParse](https://arxiv.org/abs/2602.14276), submitted 2026-02-15 and accepted at ICML 2026, introduces dense annotations for 771,000 web screenshots and 21 million visible UI elements. It reports gains from complete screen parsing supervision over sparse target-only grounding. This is strong evidence for parser coverage, but it has not been validated on Apature’s design-review tasks.

Implication:

- Judgment Engine may supply `vision_parser` or OCR observations for canvas, image-only, custom-rendered, or structurally missing regions.
- UI Graph must ingest those observations with confidence and provenance.
- UI Graph must never silently let a parser overwrite higher-confidence DOM/AX facts.

### 3.6 Marks and coordinates help only when they are selective and transform-safe

[Set-of-Mark Prompting](https://arxiv.org/abs/2310.11441), submitted 2023-10-17, shows that marks, masks, and labels can improve visual grounding across fine-grained vision tasks.

SeeAct provides counterevidence for web tasks: marks alone were not its best grounding strategy. The correct conclusion is not “SoM works” or “SoM fails,” but that marks are model- and task-dependent.

[ScreenSpot-Pro](https://arxiv.org/abs/2504.07981), submitted 2025-04-04, shows that high-resolution professional interfaces with small targets remain difficult and reports substantial gains from narrowing the search area.

[Visual Test-time Scaling for GUI Agent Grounding](https://arxiv.org/html/2505.00684v2), first submitted in May 2025, similarly reports large grounding gains from region-focused visual search.

Implication:

- Keep stable textual refs in every view.
- Generate marked crops only for ambiguous, dense, or visually dependent cases.
- Every crop and overlay needs an explicit transform back to document, viewport, and source-image coordinates.

### 3.7 Observation selection should be task-aware

[FocusAgent](https://arxiv.org/html/2510.03204v1), submitted in October 2025, reports that AX trees can be roughly an order of magnitude smaller than DOM while still reaching tens of thousands of tokens. It retrieves relevant observation lines and treats prompt injection as part of the filtering problem.

[LineRetriever](https://arxiv.org/html/2507.00210v1), submitted in July 2025, finds that planning-aware observation retrieval can reduce per-step observation size while maintaining performance.

[WebChallenger](https://arxiv.org/html/2606.10423v1), submitted 2026-06-10, introduces a deterministic DOM-derived `PageMem` of semantic sections that agents skim and expand selectively. This is highly relevant but very recent preprint evidence.

Implication:

- Persist one canonical full graph.
- Generate focused views at query time using deterministic task policies.
- Do not precompute every prompt view or expose the entire graph by default.

### 3.8 Agent memory should reference graphs, not be embedded in them

[MemGPT](https://arxiv.org/abs/2310.08560), submitted 2023-10-12, frames long-term agent context as a memory-management problem with separate active and archival tiers. [WebChallenger](https://arxiv.org/abs/2606.10423), submitted 2026-06-10, goes further for web agents by caching a structured page representation and selectively expanding semantic sections.

These systems support retaining compact, addressable representation artifacts outside the immediate prompt. They do not imply that the representation layer should own beliefs, preferences, trajectories, or memory-write policy.

Implication:

- UI Graph snapshots and diffs are memory-addressable evidence objects.
- Judgment Engine owns retention, retrieval, summaries, feedback, and agent-memory policy.
- A memory record may cite `snapshotId`, `elementRef`, and evidence refs, but UI Graph must not update long-term beliefs from agent outcomes.

### 3.9 Visual-token compression supports selective pixels but has a grounding caveat

[TokenPacker](https://arxiv.org/abs/2407.02392), submitted 2024-07-02, reports 75–89% visual-token compression with comparable performance across its evaluated benchmarks.

However, [Revisiting Visual Token Pruning for Vision-Language Model Acceleration](https://arxiv.org/html/2412.13180v2) finds that pruning can preserve many general tasks while substantially harming TextVQA and localization.

[AQuaUI](https://arxiv.org/abs/2605.19260), submitted 2026-05-19, uses adaptive quadtrees for GUI screenshots and reports 29.52% fewer visual tokens with 99.06% retained performance on one evaluated model. It is recent and model-specific.

Implication:

- UI Graph should reduce image use through crops and saliency policies, not claim model-internal visual-token compression.
- Compression benchmarks must include grounding and OCR-sensitive tasks; aggregate VQA quality is insufficient.

### 3.10 Structured snapshots reduce attack surface but do not make page content trusted

[AgentDojo](https://arxiv.org/abs/2406.13352), submitted 2024-06-19, provides 97 realistic agent tasks and 629 prompt-injection security cases.

[EVA](https://arxiv.org/abs/2505.14289), submitted 2025-05-20, demonstrates adaptive indirect prompt injection against GUI agents through visual environments.

[VPI-Bench](https://arxiv.org/html/2506.02456v2), first submitted in June 2025, evaluates visual prompt injection against computer-use agents.

[Indirect Prompt Injection in the Wild](https://arxiv.org/abs/2604.27202), submitted 2026-04-29, reports a large-scale web measurement and finds that structured representations reduced model compliance relative to plain text in its controlled experiments. This is recent preprint evidence.

[OWASP LLM01:2025](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) classifies prompt injection as the leading GenAI application risk.

Implication:

- All DOM, AX, OCR, and visible text is untrusted data.
- UI Graph should tag content origin and sensitivity, redact before serialization, and never convert page text into system-like instructions.
- Consumers still need non-model enforcement because representation alone is not a security boundary.

### 3.11 Canonical serialization and deltas need explicit integrity

[RFC 8785](https://www.rfc-editor.org/info/rfc8785), published 2020-06, defines deterministic JSON canonicalization suitable for repeatable hashing.

[RFC 6902](https://www.rfc-editor.org/info/rfc6902), published 2013-04, defines JSON Patch. It is useful prior art, but array-index paths are brittle for graph nodes and edges whose order is not semantic.

The [Protocol Buffers compatibility guidance](https://protobuf.dev/best-practices/dos-donts/) emphasizes deploy skew and never reusing removed field numbers. UI Graph uses JSON for inspectability in the MVP, but the additive-evolution principle still applies.

Implication:

- Canonicalize and hash snapshots after sorting id-addressed collections.
- Use typed graph operations keyed by IDs rather than generic array-index patches.
- Reject deltas whose base hash does not match.

## 4. Concrete Design Comparisons

### 4.1 DOM/AX snapshots vs screenshot-only vs hybrid scene graph

| Design | Strengths | Weaknesses | Latency/token/cost | Apature decision |
|---|---|---|---|---|
| DOM/AX only | Deterministic; cheap; semantic roles; direct source linkage | Misses rendered appearance, occlusion, canvas, visual hierarchy, token drift | Lowest incremental compute; text can still be very large | Baseline and primary structured input, not final representation |
| Screenshot only | Captures rendered truth and custom surfaces; model-agnostic input | OCR/grounding errors; expensive visual tokens; weak source linkage; harder privacy filtering | Highest recurring model cost; parser/VLM latency | Required baseline and selective fallback |
| Hybrid graph | Combines semantics, geometry, style, pixels, and DNA; supports selective views | More schema and fusion complexity; requires disagreement policy | Small deterministic CPU overhead; optional pixel escalation | Recommended |

Why hybrid beats AX-only for Apature: design judgment depends on visual spacing, typography, color, hierarchy, and rendered drift that AX does not encode.

Why hybrid beats screenshot-only for Apature: exact style/token facts, code-linked provenance, redaction, and repeated prompt efficiency are easier with structured evidence.

Experiment that decides: run identical review tasks with AX-only, screenshot-only, raw multimodal context, and hybrid focused views. Measure token cost, finding precision/recall, grounding Recall@1, valid refs, and latency.

### 4.2 Graph database vs immutable blobs plus indexes

| Design | Strengths | Weaknesses | Apature fit |
|---|---|---|---|
| Graph database | Flexible ad hoc traversal; cross-snapshot graph queries; centralized indexing | New service, migration, tenancy, backup, and latency surface; unnecessary for small immutable per-viewport graphs | Weak MVP fit |
| Immutable blobs + metadata/spatial indexes | Content-addressed, reproducible, cheap object storage, easy eval freezing, no write contention | Cross-snapshot analytics require a separate index or batch job | Strong MVP fit |

UI Graph’s dominant queries are bounded neighborhood, filter, ranking, and diff operations over one snapshot. Those do not justify a graph database.

Decision: canonical JSON blob in Judgment Engine’s artifact store; metadata and optional spatial/text indexes outside the blob. Revisit a graph database only if measured cross-snapshot traversals dominate and cannot meet p95 query goals with derived indexes.

### 4.3 Handcrafted edges vs learned relations

Deterministic relations such as containment, label/control, reading order, overlap, alignment, and nearest-neighbor spacing are explainable and testable. Learned relations may capture visual grouping or component families better, but introduce inference ownership, calibration, drift, and audit problems.

Decision:

- Persist deterministic core edges.
- Represent learned outputs as optional observations with model/version/confidence provenance.
- Compute dense similarity relations at query time rather than persisting an O(n²) graph.

Experiment that decides: compare deterministic edges, externally learned relations, and both on neighborhood retrieval recall and downstream finding quality. A learned edge type graduates only when it adds statistically significant value after latency and calibration costs.

### 4.4 Precomputed full graphs vs query-time focused views

Precomputing only a focused graph loses reuse and makes the representation depend on the first task. Precomputing every view creates combinatorial storage and stale ranking.

Decision: build one canonical full graph from a capture, then generate bounded views on demand. The normalized view spec includes renderer and tokenizer profiles; cache only by `(snapshotHash, viewSpecHash)`.

### 4.5 Visual embeddings vs structured token/UI-DNA matches

Structured matches answer auditable questions: “this color equals token X,” “this spacing is 6 px off the approved scale,” or “this component declares family Y.” Embeddings are useful when labels differ or a custom component resembles a canonical family, but similarity is not proof of conformance.

Decision: exact and tolerance-based structured matches are authoritative. Embeddings may retrieve candidates and must include distance, model version, and an `advisory` status.

### 4.6 Stable selector strategies

No DOM selector is universally stable. Playwright’s [best practices](https://playwright.dev/docs/best-practices) prefer user-visible semantics over implementation details. WebDriver BiDi’s [2026-06-01 Working Draft](https://www.w3.org/TR/2026/WD-webdriver-bidi-20260601/) defines shared node references for a session, but session references do not solve identity across recaptures.

Decision:

- `elementRef` is opaque and valid only within one snapshot.
- `locatorHints` are ranked evidence, not identity.
- Cross-snapshot lineage is a probabilistic match with confidence and abstention.
- CDP, AX, Playwright, and BiDi IDs are never persisted as durable external refs.

### 4.7 Graph delta protocols

Generic JSON Patch is standardized but array-index operations become unstable after sorting or compaction.

Decision: typed `replace_header`, `upsert_node`, `remove_node`, `upsert_edge`, `remove_edge`, `upsert_region`, `remove_region`, and replacement operations keyed by stable snapshot-local IDs. Every delta carries base and target schema versions and hashes. Full snapshots remain canonical.

### 4.8 Compression metrics

“Graph is smaller than DOM” is not a sufficient result. Measure:

- serialized bytes, gzip bytes, and text tokens;
- visual tokens or image-cost estimate under the consumer model profile;
- included nodes, edges, text characters, and crops;
- graph build/query time and total model latency;
- grounding Recall@1 and IoU;
- valid-reference rate;
- finding precision, recall, and severity agreement;
- evidence sufficiency judged against full context;
- cost per accepted finding and cost per successful fix.

Compression is acceptable only under a quality-retention constraint.

## 5. Recommendation for Apature

Build:

- a source-fused, immutable `UIGraphSnapshot`;
- snapshot-local opaque refs plus ranked locator hints;
- deterministic structural/spatial edges with bounded density;
- exact/tolerance-based UI-DNA matches;
- on-demand focused views and selective crops;
- content hashes, typed deltas, provenance, redaction, and sensitivity labels.

Do not build in this repo:

- screenshot parsers, OCR models, embedding inference, relation models, or VLM calls;
- browser capture or actions;
- a graph database for the MVP;
- canonical agent memory or feedback storage;
- UI-DNA extraction or approval.

## 6. Experiments That Decide the Remaining Questions

| ID | Question | Variants | Primary gate |
|---|---|---|---|
| R1 | Does hybrid beat simpler observations? | AX-only, screenshot-only, raw hybrid, UI Graph views | Quality-adjusted token cost |
| R2 | How much structure is needed? | Tree only, deterministic graph, graph + external learned facts | Grounding/finding lift per ms and token |
| R3 | When should pixels be escalated? | Always full image, rules-based crops, saliency crops, model-requested crops | Grounding at fixed visual-token budget |
| R4 | Which ref strategy survives recapture? | Role/name, test id, structural path, geometry, weighted fusion | Precision at confidence threshold and abstention rate |
| R5 | Are deltas worth the complexity? | Full snapshots, typed deltas, compressed full snapshots | Wire bytes, apply latency, corruption rate |
| R6 | Do embeddings add value over DNA matching? | Structured only, embedding retrieval, both | Component-family precision and accepted findings |
| R7 | Is a graph database warranted? | Blob scan, in-memory/spatial index, graph database prototype | p95 query latency and operational cost |
| R8 | Does focused serialization resist prompt injection better? | Raw text, AX, graph view with provenance/redaction | Utility and attack success on injection fixtures |

## 7. Research Watchlist

Revisit quarterly:

- Playwright MCP/ARIA snapshot format and ref semantics.
- W3C WebDriver BiDi node-reference stability.
- BrowserGym observation APIs and representation benchmarks.
- ScreenParse and other dense screen-parsing datasets.
- GUI grounding results on ScreenSpot-Pro and OSWorld-G.
- GUI-specific visual-token compression such as AQuaUI.
- task-aware page-memory systems such as WebChallenger.
- indirect and visual prompt-injection benchmarks.

No watchlist result changes the repository boundary: UI Graph remains the representation layer.

## 8. Source and Evidence Policy

Research was refreshed on 2026-06-18. Browser and protocol claims use official Playwright, Chrome DevTools Protocol, W3C, RFC, Protocol Buffers, and OWASP sources. Model, benchmark, parsing, compression, grounding, graph, and memory claims use original papers or project papers.

Evidence labels used in this document:

- `official specification/documentation`: authoritative for API or protocol behavior, not comparative model quality;
- `peer-reviewed paper`: stronger evidence for the studied task, still not automatically transferable to Apature;
- `preprint`: directional evidence requiring reproduction;
- `Apature hypothesis`: a product-specific claim that must pass the experiments in section 6.

The most consequential Apature recommendation—a deterministic hybrid graph with query-time focused views—remains a hypothesis until R1 passes on the frozen design-review set.
