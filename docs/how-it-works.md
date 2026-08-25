Part of [lattice](../README.md). Moved from the README on 2026-08-24; anchors preserved.

## How it works

```
capture bundle ─┐
UI-DNA          ├─> validate ─> normalize ─> fuse ─> hierarchy/regions ─> bounded relations
projection    ──┘                                                              │
                                                                               v
                                                    UI-DNA projection ─> ref allocation
                                                                               │
                                                                               v
                                              canonical serialize ─> SHA-256 ─> UIGraphSnapshot
                                                                               │
                                        ┌──────────────────────────────────────┤
                                        v                                      v
                              queryUiGraph → views                  lineage match ─> typed delta
                              + evidence requests
```

Two smaller pieces worth a look. **Selective pixel escalation** (`pipeline/evidence-request.ts`) emits ranked crop requests with a padded, viewport-clipped rect and a typed reason (`small_or_dense_target`, `source_disagreement`, `parser_only_provenance`, `high_saliency`, `requested_refs`); degenerate or out-of-bounds targets come back as typed rejections rather than a misleading crop, and a crop covering most of the viewport falls back to requesting the full screenshot. And **bounded relations**: a spatial index generates candidates, and a per-node cap plus repeated-region summarization stops a 200-row table producing a quadratic edge set.

### Design decisions

| Question | Decision |
|---|---|
| Accessibility tree, or screenshots? | Both, fused into one structured graph; pixels stay by reference |
| Graph database, or blobs? | Immutable content-addressed JSON blobs plus derived indexes |
| Full graph, or per-task graph? | One task-neutral snapshot; lossy budgeted views at query time |
| Handcrafted or learned relations? | Deterministic bounded relations; learned ones stay advisory and labeled |
| Embeddings for design-system matching? | Structured token/scale matches are authoritative; embeddings only retrieve candidates |
| Stable selectors? | No. Opaque snapshot-local refs plus ranked locator hints plus a matcher that abstains |
| Delta format? | Typed ID-keyed ops with base/target hashes; explicitly not array-index JSON Patch |
| Own the design system? | No. Consume an approved projection; never mutate, approve or extend it |
| A service, or a library? | A library inside the consumer's process; no network hop, no separate deployment |

### Boundaries

- **The graph library has no browser, no screenshots, no OCR, no model calls, no network and no database.** The capture adapter is a separate package for exactly that reason. `scripts/capability-guard.mjs` enforces the split in CI, not by convention: it denies browser/network/model/DB dependencies in the core, greps the core's source for imports of them (including Node's own `node:http` and friends, and the capture package itself), and requires the adapter's browser dependency to stay an optional peer so that consuming the core never installs one.
- **Even the adapter never edits code and never drives a UI.** It navigates, waits, scrolls to a requested offset and observes. It does not click, type, or submit. `actionMap` is a *perception* view of observed affordances; it is not an action API.
- It does not own a design system. It consumes an approved projection and matches against it.

### Degradation

The library degrades rather than fails whenever it honestly can, and fails closed when it cannot.

| Condition | Behaviour | Consumer implication |
|---|---|---|
| Screenshot unavailable | Structured graph succeeds with a warning | No pixel escalation |
| DOM/layout unavailable | Uses accessibility/derived observations if present | Lower geometry confidence |
| Accessibility tree unavailable | Structural/visual graph succeeds | Accessible semantics partial |
| Styles unavailable | No style or drift certainty | `unknown`, never a defaulted value |
| Design system unavailable | Neutral graph | No conformance claim at all |
| Element scrolled out of the viewport | Exact geometry kept; the normalized `[0,1]` rect is omitted | Position is unknown, not approximated |
| Parser conflicts with DOM | Both preserved; parser stays advisory | A crop may be required |
| Capture unstable | Page-health warning carried into every summary | Consumer applies its own confidence policy |
| Node/edge budget exceeded | Low-value detail summarized | View reports the truncation and counts |
| Ref from another snapshot | Typed `stale_or_foreign_ref` | Requery, or lineage-match |
| Delta hash mismatch | Target rejected, no partial state | Fall back to a full checkpoint |
| Sensitive content survives redaction | Rendering fails closed | Do not invoke the model with that view |

### Directory map

```
packages/schema/            @apatureai/lattice, the whole library
  src/
    api.ts                  the four public entry points + typed error codes
    query.ts                queryUiGraph: spec validation, ref verification, dispatch, budgets
    builder.ts              buildUiGraph: composes the pipeline, seals the snapshot
    canonical.ts            RFC 8785 canonical JSON, SHA-256, ref-scope digest, sealing
    types.ts                TypeScript mirror of the normative JSON Schemas
    readprofile.ts          the minimum shape read from capture + design-system producers
    adapter.ts              validation of those read profiles at the boundary
    validate.ts             ajv validation against the normative schemas
    schema-evolution.ts     executable schema diff + version-bump verdicts, dual-major reads
    capability-descriptor.ts machine-readable statement of what this package does and does not do
    consumer-contract.ts    which surface may request which view; ref resolution; forbidden deps
    pipeline/               validate → normalize → fuse → hierarchy → relations → dna-match
                            → views, plus lineage, delta, evidence-request, untrusted,
                            saliency, view-source, and the geometry/color/css/text kernels
    eval/                   synthetic capture generator, frozen fixture manifests, offline
                            benchmark runner, bootstrap stats, promotion gates, decision report
  schemas/                  mirrored normative JSON Schemas shipped with the package
  schemas-baseline/         previous-version schemas, for the evolution/compat suite
  test/                     34 vitest files incl. property tests over the geometry kernel
packages/capture/           @apatureai/lattice-capture, the producer: a real page in
  src/
    cli.ts                  `lattice-capture` / `pnpm capture`: the quickstart above
    browser.ts              the only module that knows Playwright exists; loads it lazily
    capture.ts              the CDP driver: two calls, a stability probe, per-frame a11y
    transform.ts            the whole adapter as a pure function, protocol payload in
    roles.ts                the DOM-side implicit ARIA role subset, documented as a subset
    cdp-types.ts            the exact protocol surface read, as structural types
    style.ts                the computed-style properties requested, and their fact names
  scripts/record-fixture.mjs re-record the frozen protocol payload the golden test uses
  test/                     the adapter against that frozen payload; no browser needed
  test-browser/             the live suite: real Chromium, real page, `pnpm test:browser`
schemas/                    normative JSON Schemas (snapshot, view, delta) + examples
                            (see schemas/README.md for versioning and reference loading)
examples/quickstart.mjs     the no-browser example above
scripts/capability-guard.mjs the CI gate: dependency + import boundary, determinism check
```

The JSON Schemas are the normative contract; the TypeScript types explain the same thing, and a mirror test fails if the two drift. Each schema is identified by a URN (`urn:apatureai:ui-graph:snapshot:1.0.0` and its view/delta siblings) rather than a URL, so nothing implies a fetchable endpoint and validation is provably offline. See [`schemas/README.md`](../schemas/README.md).

The source calls its caller **the consumer**: whatever critique pipeline links this library in and owns the parts it deliberately does not, which is capture, inference, storage, delivery, and redaction. The reference consumer is the sibling repo [apatureai/verdict](https://github.com/apatureai/verdict), a grounded vision-language design reviewer. This package neither depends on it nor requires it; any pipeline that supplies the documented read profiles is a consumer.

Some source comments cite section numbers (`TRD §8.1`, `PRD §6.4`, `ARCHITECTURE §7`) from earlier design documents that are not part of this repository. They are left in place as provenance for where a rule came from.
