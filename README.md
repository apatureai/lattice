# Apature UI Graph

Token-efficient, UI-DNA-aware representation of rendered product UI.

UI Graph converts versioned capture evidence and an approved UI-DNA `GraphProjection` into an immutable, queryable scene graph. The graph fuses DOM/layout facts, accessibility semantics, computed visual facts, screenshot coordinates, and design-system matches without making any one source authoritative.

The default consumer is `apatureai/judgment-engine`, which uses UI Graph to build smaller grounded prompt views for Gate, MCP Review, Pointer, and future surfaces.

## Canonical Boundary

UI Graph owns:

- `UIGraphSnapshot`, `UIGraphView`, and `UIGraphDelta` contracts.
- Deterministic source fusion, node identity, relation construction, UI-DNA projection, and prompt-view serialization rules.
- Snapshot-local element references and cross-snapshot match hints.
- Representation benchmarks: tokens, bytes, latency, grounding retention, and reference validity.

UI Graph does not own:

- Browser capture, screenshots, OCR, visual-parser inference, embeddings, or model calls.
- The canonical UI-DNA schema, extraction, approval, or storage.
- Browser actions, code changes, GitHub delivery, feedback storage, or agent memory.
- Evaluation execution or model/prompt promotion. Judgment Engine owns the harness; UI Graph defines representation fixtures and metrics consumed by it.

## Recommended Shape

For the MVP, UI Graph is a deterministic versioned package used by Judgment Engine, not a separately deployed service.

1. Judgment Engine captures a route and emits an authorized `CaptureBundle`.
2. UI DNA supplies an approved `GraphProjection`; non-canonical draft data is allowed only in explicitly authorized offline/shadow evaluation and can never produce authoritative matches.
3. UI Graph builds one immutable full snapshot and stores large evidence behind refs.
4. Consumers request task-focused views such as `summary`, `violations`, `focus`, `actionMap`, or `diff`.
5. Judgment Engine decides which views and crops enter a model call.

The canonical persisted representation is structured JSON validated by JSON Schema. Query views are generated on demand. Typed graph deltas are a transport optimization for live or repeated observations, not the source of truth.

## Documents

- [RESEARCH.md](RESEARCH.md) — primary-source research, design comparisons, and evidence strength.
- [PRD.md](PRD.md) — outcomes, scope, success gates, rollout, and ownership.
- [TRD.md](TRD.md) — build-ready contracts, schema rules, algorithms, benchmarks, and security requirements.
- [ARCHITECTURE.md](ARCHITECTURE.md) — boundaries, data flow, sequence diagrams, ADRs, and failure handling.
- [Snapshot schema](schemas/ui-graph-snapshot.schema.json) — normative `UIGraphSnapshot` JSON Schema.
- [View schema](schemas/ui-graph-view.schema.json) — normative `UIGraphView` JSON Schema.
- [Delta schema](schemas/ui-graph-delta.schema.json) — normative `UIGraphDelta` JSON Schema.
- [Schema guide](schemas/README.md) — local reference loading, versioning, and integrity rules.

`ARCHITECTURE.md` and the schemas are normative. The existing poster files are explanatory only and must not override the written contracts.

## Decision Summary

| Question | MVP decision |
|---|---|
| AX/DOM or screenshots | Hybrid structured graph; screenshot evidence and parser observations are selective fallbacks |
| Graph database or blobs | Immutable canonical JSON blobs plus metadata/spatial indexes |
| Full graph or focused graph | Build one full snapshot; render focused views at query time |
| Handcrafted or learned relations | Deterministic core relations; optional learned observations stay provenance-labeled |
| Embeddings or UI-DNA/token matches | Structured matches first; embeddings only retrieve candidates |
| Stable selectors | Opaque snapshot refs plus ranked locator hints and probabilistic cross-snapshot matching |
| Delta format | Typed id-based operations, explicit header replacement, and base/target hashes; no array-index JSON Patch |
| Compression objective | Minimize tokens and visual crops subject to grounding and finding-quality retention |

## Build Gate

Do not integrate UI Graph into production prompts until the frozen evaluation set shows:

- at least 70% total input-token reduction against screenshot-plus-raw-structure context;
- no more than 2 percentage points loss in finding recall and no more than 1 point loss in precision;
- at least 99.5% valid snapshot-local references;
- at least 98% precision for high-confidence cross-snapshot matches;
- no unbounded node/edge growth on repeated lists or dense layouts; and
- p95 deterministic build overhead at or below 300 ms for a 1,000-node capture, excluding artifact I/O and optional upstream inference.
