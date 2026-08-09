# ui-graph

> **Archived.** This repository is part of the open-source release of Apature, a product that has
> been wound down. It is no longer actively developed. The code is published as-is under the MIT
> license; issues and pull requests are unlikely to be reviewed. It is here because the design is
> worth reading, not because anyone is running it.

`@apature/ui-graph` turns a browser capture of a rendered web page — DOM/layout nodes,
accessibility-tree nodes, computed styles, text runs, screenshot coordinates — into a single
immutable, content-addressed JSON graph, and then renders small task-focused text views of that
graph to put in a vision-language model's prompt. The goal is compression with receipts: instead
of pasting a full screenshot plus a raw DOM dump into a model call, you give the model a bounded
set of fused, deduplicated, provenance-labeled facts, plus short opaque references it can cite,
plus an explicit list of the image crops it would need to resolve anything genuinely visual.

That the compression goal was ever *met* is not something this repo demonstrates — see
[Limits](#limits-and-what-never-shipped) before you believe the pitch.

It is a pure library. It never opens a browser, never calls a model, never touches the network or a
database, and never writes code or drives a UI. It takes JSON in and returns JSON out. That
boundary is enforced in CI by a script (`scripts/capability-guard.mjs`), not just by convention.

## Why this is interesting

The hard problem is not "describe a page to an LLM." It is describing a page cheaply while keeping
every claim traceable and every pointer honest. Four ideas do most of the work here.

**No source is authoritative; sources are fused with provenance.** The accessibility tree knows
roles and names. The layout tree knows geometry and clipping. Computed style knows typography and
color. OCR or a visual parser (supplied from outside — this package never runs one) knows what is
inside a `<canvas>`. Each of these is right about different things and wrong about others.
`pipeline/fuse.ts` merges observations by explicit backend/source ID where one exists, and otherwise
by frame + geometric overlap + role/text compatibility. When two sources disagree it does *not*
pick a winner: it keeps both claims on the node, flags the conflict, and lets the consumer decide
whether to escalate to pixels. Every fact carries an `EvidenceClaim` naming the source type,
provider, and confidence, so a downstream finding can always say where it came from.

**Content-addressed identity with an acyclic reference scope.** A sealed `UIGraphSnapshot` is
hashed with RFC 8785 (JSON Canonicalization Scheme) — hand-written in `canonical.ts`, with
locale-independent key ordering, ECMAScript number production, `-0` normalized to `0`, and
NaN/Infinity rejected. Nodes carry short `elementRef` strings that a model cites in its findings.
Those refs are derived from a *ref-scope digest*: the snapshot hashed with the identity fields and
the refs themselves removed, which breaks the obvious cycle (refs are in the content, the content
determines the hash, the hash determines the refs). Refs are snapshot-local by construction; using
one against a different snapshot returns a typed `stale_or_foreign_ref` error rather than resolving
to the wrong element. Cross-capture identity is a separate, explicitly probabilistic problem —
see below. The two are kept apart on purpose: a confidently wrong pointer is more damaging than a
missing one.

**A matcher that abstains.** `pipeline/lineage.ts` scores each node in a base snapshot against
candidates in a target snapshot over weighted deterministic features (explicit id 0.35, name 0.20,
role 0.15, geometry 0.15, region 0.10, kind 0.05). A node is reported `matched` only if the best
candidate clears a threshold *and* beats the runner-up by a margin; two close candidates yield
`ambiguous`, a weak best yields `abstained`, no candidate yields `removed`. It is designed to say
"I don't know" instead of guessing, because the consumer of a wrong match is a review comment
pointing at the wrong button.

**Prompt views as a budgeted, fail-closed rendering problem.** `pipeline/views.ts` renders six view
kinds — `focus` (bounded BFS neighborhood around cited refs), `summary`, `actionMap`,
`patchContext`, `violations`, and `diff`. Every rendered view reports what it dropped: truncation
flag, omitted node/edge counts, a token estimate, the resolved and *unresolved* refs, and the
policy version that produced it. Rendering is deterministic (the same graph yields byte-identical
text) and fails closed: if no ref resolves, you get an explicit empty view naming the bad refs, not
a plausible-looking guess. Page-derived text is treated as data, never instructions — it is
wrapped in `<<<UNTRUSTED_UI_CONTENT>>>` markers, occurrences of those markers inside page text are
neutralized so content cannot forge the boundary, and ASCII control characters are stripped. If a
node labeled `pii`/`secret`/`credential` still carries text at render time, upstream redaction
failed and the whole view throws rather than serializing the leak.

Two smaller pieces worth a look:

- **Selective pixel escalation** (`pipeline/evidence-request.ts`). Views don't embed images; they
  emit ranked `EvidenceRequest`s — a padded, viewport-clipped crop rect, the refs it covers, and a
  typed reason (`small_or_dense_target`, `source_disagreement`, `parser_only_provenance`,
  `high_saliency`, `requested_refs`). Degenerate or out-of-bounds targets come back as typed
  rejections instead of a misleading crop, and a crop that would cover most of the viewport falls
  back to requesting the full screenshot. A request is a recommendation, not an authorization: the
  caller decides whether pixels enter the model call.
- **Hash-verified deltas** (`pipeline/delta.ts`). Deltas are ID-keyed typed operations bound to
  both `(snapshotId, contentHash)` tuples, with explicit — never cascading — incident-edge removal.
  Applying one recomputes the base identity from content (the supplied fields are not trusted),
  applies ops in order, re-seals the result, and requires the reconstructed hash to equal the
  delta's declared target. Any failure yields a typed error and *no* partial snapshot. Deltas are
  transport only; full snapshots stay canonical.

## Where it sat in the stack

UI Graph was a library inside another service's process, not a deployed component. The intended
flow:

1. [`judgment-engine`](https://github.com/apatureai/judgment-engine) captures a route in a browser
   sandbox and emits a `CaptureBundle`.
2. [`ui-dna`](https://github.com/apatureai/ui-dna) supplies an approved `GraphProjection` — the
   repo's own design system (tokens, scales, component families, rules) in the shape UI Graph can
   match against.
3. UI Graph builds one immutable, task-neutral snapshot and renders bounded views on demand.
4. Judgment Engine assembles the prompt, runs the model, and delivers findings to the product
   surfaces: [`gate`](https://github.com/apatureai/gate) (CI review) and
   [`mcp-review`](https://github.com/apatureai/mcp-review) (the same engine over MCP, for coding
   agents).

`src/consumer-contract.ts` encodes which surface may request which view kinds, and what a consumer
is forbidden from depending on — notably, an `elementRef` is never a CSS selector or a browser
handle, and `actionMap` is a *perception* view listing observed affordances, never an execution
affordance.

Other repos in the same open-source release, with no code dependency in either direction:
[`entropy-engine`](https://github.com/apatureai/entropy-engine),
[`sigil`](https://github.com/apatureai/sigil).

Every `apatureai/*` link above points at a sibling repository from the same wound-down project.
They are being released together; if one has not been made public yet, its link will 404. Some
surfaces named in the design documents (Pointer, Interactive Review, Source of Truth) were never
built and are not part of this release. Nothing in this repository depends on any of them at
build or run time.

## Quickstart

Requires Node 24 (see `.node-version`) and pnpm 9.15.0.

```sh
pnpm install
pnpm build              # tsc -b across project references
pnpm typecheck          # same as build; type-only
pnpm test               # vitest run
pnpm lint               # eslint, warnings fail
pnpm guard:capability   # the no-model/browser/network/DB + determinism gate
```

All five were run against this tree at archive time and pass: 304 tests across 31 files, clean
lint, clean capability guard. There is nothing to start — no server, no CLI, no published npm
package.

The API surface (`packages/schema/src/api.ts`):

```ts
import { buildUiGraph, diffUiGraphs, applyUiGraphDelta } from "@apature/ui-graph";

const { snapshot, diagnostics } = await buildUiGraph({
  capture,          // CaptureBundleReadProfile — see src/readprofile.ts
  dna,              // optional approved GraphProjection read profile
  options: {
    builderVersion: "ui-graph-builder@0.1.0",
    schemaVersion: "1.0.0",
    relationPolicyVersion: "relations@1",
    dnaProjectionVersion: "dna@1",
    redactionPolicyVersion: "redaction@1",
    useMode: "offline_eval",   // "production" | "shadow" | "offline_eval"
    maxNodes: 2000,
    maxPersistedEdgesPerNode: 8,
    repeatedRegionThreshold: 3,
    textPolicy: "truncate",
    includeHiddenExplanatoryNodes: false,
  },
});
```

`useMode` is part of the deterministic input hash, so shadow and production artifacts can never
collide, and any non-production mode forces every design-system match to `authoritative: false`.

Views are called directly today rather than through a single dispatcher — see *Limits* below:

```ts
import { renderFocusView, renderViolationsView, buildEvidenceRequests } from "@apature/ui-graph";
```

## Repo layout

A pnpm workspace with exactly one package.

```
packages/schema/            @apature/ui-graph — the whole library
  src/
    api.ts                  public entry points + typed error codes
    types.ts                TypeScript mirror of the normative JSON Schemas
    readprofile.ts          the minimum shape it reads from capture + UI-DNA producers
    adapter.ts              validation of those read profiles at the boundary
    builder.ts              buildUiGraph: composes the pipeline, seals the snapshot
    canonical.ts            RFC 8785 canonical JSON, SHA-256, ref-scope digest, sealing
    validate.ts             ajv validation against the normative schemas
    schema-evolution.ts     executable schema-diff + version-bump verdicts, dual-major reads
    capability-descriptor.ts machine-readable statement of what this package does and does not do
    consumer-contract.ts    which product surface may request which view; forbidden dependencies
    pipeline/               validate → normalize → fuse → hierarchy → relations → dna-match
                            → views, plus lineage, delta, evidence-request, untrusted,
                            saliency, and the geometry/color/css/text kernels
    eval/                   frozen fixture manifests, offline benchmark runner, bootstrap stats,
                            pre-registered promotion gates, decision report
  schemas/                  mirrored normative JSON Schemas shipped with the package
  schemas-baseline/         previous-version schemas, for the evolution/compat suite
  test/                     31 vitest files incl. property tests over the geometry kernel
schemas/                    normative JSON Schemas (snapshot, view, delta) + examples
scripts/capability-guard.mjs the CI gate described above
```

The JSON Schemas are the normative contract; the TypeScript types explain the same thing, and a
mirror test fails if the two drift.

## Architecture

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
                              task-focused views                    lineage match ─> typed delta
                              + evidence requests
```

Design decisions, with the reasoning in `ARCHITECTURE.md`'s ADRs:

| Question | Decision |
|---|---|
| Accessibility tree, or screenshots? | Both, fused into one structured graph; pixels stay by reference |
| Graph database, or blobs? | Immutable content-addressed JSON blobs plus derived indexes |
| Full graph, or per-task graph? | One task-neutral snapshot; lossy budgeted views at query time |
| Handcrafted or learned relations? | Deterministic bounded relations; learned ones stay advisory and labeled |
| Embeddings for design-system matching? | Structured token/scale matches are authoritative; embeddings only retrieve candidates |
| Stable selectors? | No. Opaque snapshot-local refs plus ranked locator hints plus a matcher that abstains |
| Delta format? | Typed ID-keyed ops with base/target hashes; explicitly not array-index JSON Patch |

Relations are bounded by construction — a spatial index generates candidates, and a per-node cap
plus repeated-region summarization stops a 200-row table from producing a quadratic edge set.

## Limits, and what never shipped

Be clear-eyed about this: the library is well-tested against synthetic fixtures and was never
validated against real production traffic. Specifically:

- **The token-efficiency claim is unproven, and the only in-repo measurement cuts against it.**
  On all four capture fixtures in `packages/schema/test/fixtures/capture/`, a rendered summary
  view is *larger* than the raw capture JSON it came from — 738→923, 1537→4115, 1676→2482,
  1758→3513 bytes. Those fixtures are 1–4 nodes, so fixed per-node provenance overhead dominates
  and this is not evidence that the design fails at scale; view payloads also currently serialize
  the full `evidence[]` array. But it is the only measurement in the repo, and it points the wrong
  way. Whether the design wins on realistic pages (hundreds of nodes, screenshot tokens in the
  baseline) was never measured. Treat "token-efficient" as the design objective, not a result.
- **`queryUiGraph()` is a stub.** It throws `UIGraphError` with code `not_implemented`. The six
  renderers exist and are tested, but the spec-driven dispatcher that would accept a
  `UIGraphViewSpec` (token/node/edge/crop budgets, tokenizer profile, comparison snapshot) and emit
  the schema-shaped `UIGraphView` envelope was never wired. The `UIGraphView` JSON Schema and type
  exist; nothing in this repo produces one.
- **The renderer seam is inconsistent.** `renderFocusView`, `renderSummaryView`, and
  `renderActionMapView` take intermediate pipeline output (`FusedNode`/`NodeHierarchy`), while
  `renderPatchContextView`, `renderViolationsView`, and `renderDiffView` take sealed
  `UIGraphNode[]`. There is no single path from a sealed snapshot to every view; unifying that was
  part of the unfinished `queryUiGraph` work.
- **No producer schemas.** The `CaptureBundle` and UI-DNA `GraphProjection` schemas were never
  published in the shape this package consumes. `src/readprofile.ts` is UI Graph's declared
  *target* read profile plus golden fixtures that pin it. To feed this real browser data you must
  write the adapter yourself.
- **The benchmark was never run on real data, and the promotion gates were never met.**
  `eval/` contains the machinery — frozen synthetic fixture sets, a deterministic benchmark
  runner, paired bootstrap confidence intervals, exact McNemar, and the PRD's numeric thresholds
  pre-registered as constants (≥70% token reduction, ≥99.5% valid refs, ≥98% cross-snapshot match
  precision, ≤2pp finding-recall loss, and so on). Every fixture is synthetic. All model-dependent
  evidence — grounding recall, finding precision/recall, latency — was to be supplied by the
  consumer's eval runs and never was. The gate is fail-closed, so with the repo as it stands the
  verdict is "insufficient evidence," not "promote."
- **The `b4_full_graph` benchmark row is still marked `diagnosticOnly`.** It serializes a
  pre-assembler composite of the pipeline stages rather than the sealed snapshot, even though the
  sealed-snapshot assembler later landed in `builder.ts`. The promotion gate refuses
  diagnostic-only rows for the token-reduction criterion, so that gate can never pass as shipped.
- **Token counts are estimates.** The default text counter is `chars / 4` and the default image
  counter is a 16px-patch estimator, both explicitly labeled as such. They are ports; the real
  consumer was expected to inject model-native counters.
- **Never promoted to production.** The whole package was gated behind a feature flag with
  `useMode` defaulting to shadow/offline evaluation, pending the eval above. As far as this repo
  shows, it never ran in `production` mode against customer traffic.
- **Not published to npm** and no credentials of any kind are required — or accepted — by this
  package. It has exactly two runtime dependencies, `ajv` and `ajv-formats`, both allowlisted with
  a justification in the capability guard.

## Further reading

The design documents are longer and more opinionated than this README, and they are the real
artifact. They were written mid-2026 as live internal specifications, in the future tense, for a
product that was still being built. They are preserved as written, with an archival note added at
the top of each and links removed into repositories that are not part of this release.

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — boundaries, data flow, sequence diagrams, ten ADRs, and
  the failure/degradation matrix (what happens when the screenshot, the accessibility tree, the
  styles, or the design system is missing).
- [`TRD.md`](TRD.md) — the build-ready contracts: schema rules, algorithms, benchmarks, security
  requirements.
- [`PRD.md`](PRD.md) — outcomes, scope, and the numeric success gates.
- [`RESEARCH.md`](RESEARCH.md) — the primary-source research and design comparisons behind the ADRs,
  with graded evidence strength and explicit counter-evidence. It stands on its own.
- [`schemas/README.md`](schemas/README.md) — schema versioning, local reference loading, integrity.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — retained for the ownership-boundary and determinism rules,
  which explain why the code is shaped this way. The repo is archived; contributions are not
  expected.
- [`SECURITY.md`](SECURITY.md) — read this before running the library against anything real.

## License

MIT. See [`LICENSE`](LICENSE).
