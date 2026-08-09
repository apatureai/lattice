# ui-graph

**Archived — provided as-is, no updates expected.** Issues and pull requests are not monitored. Last verified working 2026-08-09 on macOS 15.6.1 + Node 24.14.0 + pnpm 9.15.0.

A pure TypeScript library that fuses browser capture evidence — DOM/layout, accessibility tree, computed styles, text runs — into one immutable, content-addressed scene graph, and renders small budgeted text views of it for a vision-language model's prompt.

## Why this exists

It was part of Apature, a GitHub-native design reviewer that screenshotted a pull request's preview deploy and critiqued the rendered UI against the repo's own design system. UI Graph was the representation layer: the thing that decided *what about the page* the model got to see, and made every claim traceable back to the source that produced it. Apature has been wound down and the code is published under MIT. It is here because the representation problem — describe a page cheaply, keep every pointer honest — is still unsolved, and this is a complete, tested attempt at it.

## What it does

- Fuses DOM, accessibility, style and text observations into one graph **without letting any source silently win** — disagreements are retained as coexisting evidence claims and flagged.
- Seals each graph into a content-addressed `UIGraphSnapshot` using RFC 8785 canonical JSON, with short `elementRef` pointers a model can cite.
- Answers a `UIGraphViewSpec` with `queryUiGraph` — six view kinds (`summary`, `focus`, `actionMap`, `patchContext`, `violations`, `diff`), each budgeted, deterministic, and explicit about what it dropped.
- Measurably shrinks the prompt: on the bundled 130-node synthetic page, a focused view is **93% smaller** than the capture it came from and an action map **94%** (numbers and method under [Token efficiency](#token-efficiency)).
- Projects a supplied design system onto the graph and ranks the drift, separating authoritative deterministic matches from advisory ones.
- Matches nodes across two snapshots with a matcher that **abstains** rather than point at the wrong element.
- Emits ranked crop requests instead of embedding images — a recommendation the caller may decline.
- Applies hash-verified typed deltas, or fails closed with no partial snapshot.

## What it does not do

- No browser, no screenshots, no OCR, no model calls, no network, no database. JSON in, JSON out. This is enforced in CI by `scripts/capability-guard.mjs`, not by convention.
- It never edits code and never drives a UI. `actionMap` is a *perception* view of observed affordances; it is not an action API.
- It does not own a design system. It consumes an approved projection and matches against it.
- It is not published to npm and has no server, daemon or CLI beyond the example script.

## Requirements

| Tool | Floor | Check |
|---|---|---|
| Node | v24 | `node -v  # need v24.x` |
| pnpm | 9.15.0 | `pnpm -v  # need 9.15.0` |

```sh
corepack enable          # installs the pnpm version pinned in package.json
```

Tested on macOS 15.6.1. Linux is very likely fine (CI ran on `ubuntu-latest`); Windows was never tried. No credentials, API keys or network access are required — or accepted — by any command in this README. Dependencies are pinned and `pnpm-lock.yaml` is committed, so `--frozen-lockfile` reproduces the verified tree exactly.

## Install

From a clean clone, at the repo root:

```sh
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` is `tsc -b` across the workspace project references. The quickstart imports the compiled output, so it needs this step; the test suite runs against `src` through a Vitest alias and does not.

## Quickstart

One command, no credentials. It generates a deterministic synthetic page capture (130 DOM nodes, 130 accessibility nodes, 93 text runs), builds a sealed snapshot, asks it five bounded questions, and shows what a tight token budget does to one of them.

```
$ node examples/quickstart.mjs
1. Synthetic capture (no browser was involved)
   route              /deployments  @ 1440x900 css px
   dom/layout nodes   130
   accessibility      130
   text runs          93
   canonical JSON     60639 bytes (15158 est. tokens)

2. buildUiGraph — fuse, hierarchy, relations, DNA projection, seal
   snapshotId         ugs_1_53c63b1f244c958dfd081cdd845cd6520579af0a25d2344744f370e92edb990f
   contentHash        sha256:53c63b1f244c958dfd081cdd845cd6520579af0a25d2344744f370e92edb990f
   nodes / edges      130 / 400
   regions            35
   retained conflicts 1   (DOM said "link", accessibility said "button" — both kept)
   canonical JSON     444259 bytes

3. queryUiGraph — five views of the same snapshot (focus/patchContext on ug:1326dcdb:2)
   view             bytes  est.tok  nodes  vs capture  truncation
   summary          31430     7857    118       48.2%  none
   actionMap         3394      849     14       94.4%  none
   violations       20355     5089     85       66.4%  none
   focus             4155     1039      9       93.1%  none
   patchContext      1439      360      1       97.6%  none
   ("vs capture" is the reduction against the canonical capture JSON above.)

4. The same summary under maxTextTokens: 1000 — budgets truncate, they never throw
   est. tokens        644 (was 7857)
   nodes described    6 (was 118)
   reason             text_token_budget: node budget reduced 400 → 3
   reason             node_budget: 119 nodes omitted
   reason             region_budget: 32 regions omitted

5. actionMap — 14 perceivable affordances (perception only; never an action API)
   ug:1326dcdb:10  link      Settings                  @ 0.53,0.03 (visible)
   ug:1326dcdb:2   button    New review                @ 0.88,0.02 (visible)
   ug:1326dcdb:20  link      Open production           @ 0.03,0.30 (visible)
   ug:1326dcdb:21  link      Open staging              @ 0.19,0.30 (visible)
   ug:1326dcdb:22  link      Open preview              @ 0.34,0.30 (visible)
   … 9 more

6. Compression with receipts — the view is lean, the provenance is not lost
   ug:1326dcdb:2 resolves in this snapshot: true
   evidence claims on that node: 4
     dom             conf 0.9   role=link, tag=a
     accessibility   conf 0.85   role=button, name=New review
     text_run        conf 0.8   text=New review
     computed_style  conf 0.9   style:backgroundColor, style:borderRadiusCssPx, style:color, style:fontSizeCssPx, style:spacing
   flags: conflict:role
   a ref from another snapshot is refused: stale_or_foreign_ref

7. patchContext requested 1 crop(s) — recommendations the caller may decline
   crop of artifact://apature/synthetic-dashboard/root.png
     rect 1240,0 200x78  refs ug:1326dcdb:2  because requested_refs,source_disagreement

8. Wrote out/capture.json, out/snapshot.json and 5 out/view-*.json files.

OK — built snapshot ugs_1_53c63b1f244c95… and rendered 5 schema-valid views.
```

**Success criterion:** the last line reads `OK — built snapshot … and rendered 5 schema-valid views.`, and `out/` contains seven JSON files (`capture.json`, `snapshot.json`, and `view-summary.json`, `view-actionMap.json`, `view-violations.json`, `view-focus.json`, `view-patchContext.json`). The snapshot id is content-addressed, so it will be byte-for-byte the one printed above — if yours differs, something is wrong.

Open `out/view-focus.json` to see what actually goes into a prompt, and `out/snapshot.json` to see the provenance that stayed behind.

If the first line is `Cannot find module '.../packages/schema/dist/index.js'`, you skipped `pnpm build`.

## Usage

Four entry points, all synchronous except the builder.

The package is not published to npm. Inside this repo, tests import it as `@apature/ui-graph` (aliased to the source in `vitest.config.ts`) and plain Node scripts import the build directly, the way `examples/quickstart.mjs` does:

```js
import { buildUiGraph, queryUiGraph } from "./packages/schema/dist/index.js";
```

### `buildUiGraph(request) → { snapshot, diagnostics }`

```ts
import { buildUiGraph, syntheticCapture, syntheticDna } from "@apature/ui-graph";

const { snapshot, diagnostics } = await buildUiGraph({
  capture: syntheticCapture(),        // CaptureBundleReadProfile — see src/readprofile.ts
  dna: syntheticDna(),                // optional design-system projection
  options: {
    builderVersion: "ui-graph-builder@0.1.0",
    schemaVersion: "1.0.0",
    relationPolicyVersion: "relations@1",
    dnaProjectionVersion: "dna-projection@1",
    redactionPolicyVersion: "redaction@1",
    useMode: "offline_eval",          // "production" | "shadow" | "offline_eval"
    maxNodes: 2000,
    maxPersistedEdgesPerNode: 8,
    repeatedRegionThreshold: 3,
    textPolicy: "truncate",
    includeHiddenExplanatoryNodes: false,
  },
});
```

`useMode` participates in the deterministic input hash, so shadow and production artifacts can never collide, and any non-production mode forces every design-system match to `authoritative: false`. Failures are `UIGraphError` with a typed `code` — `invalid_build_options`, `invalid_capture`, `invalid_dna`, `invalid_snapshot`, `non_approved_dna_in_production` — and never a partial snapshot.

### `queryUiGraph(request) → UIGraphView`

```ts
import { queryUiGraph } from "@apature/ui-graph";

const view = queryUiGraph({
  snapshot,
  spec: {
    kind: "focus",                    // summary | focus | actionMap | patchContext | violations | diff
    refs: ["ug:1326dcdb:2"],          // required for focus and patchContext
    maxTextTokens: 4000,
    maxNodes: 400,
    maxEdges: 400,
    maxCrops: 2,
    includeSensitive: false,          // the only accepted value
    tokenizerProfile: "char-quarter-estimate@1",
    rendererVersion: "ui-graph-renderer@0.2.0",
  },
  screenshotArtifactRef: "artifact://…",   // optional; without it, no crops are planned
});
```

Returns the schema-shaped `UIGraphView` envelope: `text`, `includedNodeIds`, `includedEdgeIds`, `evidenceRequests`, `budget`, `truncation`, `warnings`, plus a derived `viewId` and `specHash`. Behaviour worth knowing:

- **Refs are verified, never guessed.** A malformed ref is `invalid_view_spec`; a well-formed ref that is not a member of *this exact snapshot* (full `(snapshotId, contentHash)` tuple, exact membership — never a prefix match) is `stale_or_foreign_ref`.
- **`includeSensitive: false` is enforced here**, not assumed of the caller. Nodes labelled `pii`/`secret`/`credential`/`redacted` lose their name and text in the projection and are flagged `withheld:sensitive`. If sensitive text somehow survives to render time, the view throws rather than serialize the leak.
- **Budgets truncate; they never throw.** `maxNodes` and `maxEdges` bound the render directly. `maxTextTokens` is enforced by re-rendering with a deterministically halving node budget until it fits, and the reduction is reported in `truncation.reasons`.
- **Identity is derived.** `specHash` is the canonical hash of the normalized spec (renderer and tokenizer profiles included); `viewId` derives from the snapshot content hash and that spec hash. Same question, same id.
- **`kind: "diff"`** additionally requires `comparisonSnapshot` and a matching `comparisonSnapshotId`/`comparisonContentHash` in the spec.

### `diffUiGraphs(base, target) → UIGraphDiff`

Runs the abstaining lineage matcher directly. Each base node is scored against target candidates over weighted deterministic features — explicit id 0.35, name 0.20, role 0.15, geometry 0.15, region 0.10, kind 0.05. A node is `matched` only if the best candidate clears 0.7 *and* leads the runner-up by 0.1; two close candidates are `ambiguous`, a weak best is `abstained`, no candidate is `removed`.

The explicit-id feature reads durable DOM attributes (`data-testid`, `id`, `href`, `name`) that the capture reported under `attributes`. A capture that reports none cannot reach the match threshold at all, and the matcher will correctly abstain on everything. On the synthetic page, 44 of 130 nodes match and 86 abstain — exactly the elements that carry a test id versus the ones that do not.

### `applyUiGraphDelta(base, delta) → UIGraphSnapshot`

Deltas are ID-keyed typed operations bound to both `(snapshotId, contentHash)` tuples, with explicit — never cascading — incident-edge removal. Applying one recomputes the base identity from content (supplied fields are not trusted), applies ops in order, re-seals, and requires the reconstructed hash to equal the delta's declared target. Any failure is a typed error and *no* partial snapshot. Deltas are transport only; full snapshots stay canonical.

## Token efficiency

The original claim was that this representation is cheaper than pasting raw context into a prompt. Until this release, the only measurement in the repo contradicted it: on all four golden fixtures a rendered summary view was **larger** than the capture it summarized (738→923, 1537→4115, 1676→2482, 1758→3513 bytes). The cause was the projection, not the design — view text canonicalized whole fused nodes, including the entire `evidence[]` provenance chain, frame rects, coordinate-space ids and per-fact confidences.

`views@2` fixes that. A view carries only what a model can act on — ref, kind, containment, role, name, text, a normalized rect, visibility, retained conflict markers, flags — and provenance stays in the snapshot, addressable by the same ref the view emits. Measured now, with the baseline being canonical JSON bytes of the whole capture bundle:

| Capture | Nodes | Capture bytes | Summary view | Reduction |
|---|---|---|---|---|
| `test/fixtures/capture/minimal.json` | 1 | 738 | 403 | 45% |
| `test/fixtures/capture/multi-frame.json` | 4 | 1537 | 801 | 48% |
| `test/fixtures/capture/with-derived.json` | 3 | 1676 | 642 | 62% |
| `test/fixtures/capture/judgment-engine.golden.json` | 2 | 1758 | 647 | 63% |
| `syntheticCapture()` (the quickstart page) | 130 | 60639 | 31430 | 48% |

A page summary describes the whole page, so halving it is about the ceiling. The bounded views are where the design pays — same synthetic page, same 60639-byte baseline, no token budget applied:

| View | Bytes | Est. tokens | Reduction vs capture |
|---|---|---|---|
| `patchContext` (1 ref) | 1439 | 360 | 97.6% |
| `actionMap` | 3394 | 849 | 94.4% |
| `focus` (1 ref, radius 2) | 4155 | 1039 | 93.1% |
| `violations` | 20355 | 5089 | 66.4% |
| `summary` | 31430 | 7857 | 48.2% |

The second table is exactly what `node examples/quickstart.mjs` prints; the first comes from `test/eval.synthetic-page.test.ts`, which re-derives it on every run. Read the numbers carefully:

- Token counts are `⌈chars/4⌉` estimates, clearly labelled as such throughout the code. They are ports; a real consumer injects model-native counters.
- The baseline is raw structured context only. It contains no image tokens, so this table is **not** a comparison against a screenshot-based prompt — the original benchmark harness in `src/eval/` was built to make that comparison and was never run against real pages.
- The invariant "every view is smaller than its capture" is now a test (`test/eval.synthetic-page.test.ts`). It fails the build if a future change reintroduces the regression.
- Compression is *not* free of information here, and it was never claimed to be free of judgment: what is dropped is provenance the model cannot use, which stays retrievable in the snapshot under the same ref.

## Configuration

None. No environment variable is read anywhere in this repository — verified with `grep -rn "process.env" packages scripts examples`, which returns nothing. Everything is a function argument.

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

### The four ideas that carry the design

**No source is authoritative; sources are fused with provenance.** The accessibility tree knows roles and names. The layout tree knows geometry and clipping. Computed style knows typography and color. A visual parser or OCR (supplied from outside — this package never runs one) knows what is inside a `<canvas>`. Each is right about different things. `pipeline/fuse.ts` merges observations by explicit backend/source id where one exists, otherwise by frame + geometric overlap + role/text compatibility. Competence is decided **per fact**, never globally. When two sources disagree it does not pick a winner: it keeps both claims, flags the conflict, lowers confidence, and lets the consumer decide whether to escalate to pixels.

**Content-addressed identity with an acyclic reference scope.** A sealed snapshot is hashed with RFC 8785 (JSON Canonicalization Scheme) — hand-written in `canonical.ts`, with locale-independent key ordering, ECMAScript number production, `-0` normalized to `0`, and NaN/Infinity rejected. Nodes carry short `elementRef` strings derived from a *ref-scope digest*: the snapshot hashed with the identity fields and the refs themselves removed, which breaks the obvious cycle (refs are in the content, the content determines the hash, the hash determines the refs). Refs are snapshot-local by construction. Cross-capture identity is a separate, explicitly probabilistic problem, kept apart on purpose: a confidently wrong pointer is more damaging than a missing one.

**A matcher that abstains.** See `diffUiGraphs` above. It is designed to say "I don't know", because the consumer of a wrong match is a review comment pointing at the wrong button.

**Views as a budgeted, fail-closed rendering problem.** Every rendered view reports what it dropped: truncation flag, omitted node/edge counts, a token estimate, resolved and *unresolved* refs, and the policy version that produced it. Rendering is deterministic — the same graph yields byte-identical text. Page-derived text is data, never instructions: it is wrapped in `<<<UNTRUSTED_UI_CONTENT>>>` markers, occurrences of those markers inside page text are neutralized so content cannot forge the boundary, and ASCII control characters are stripped.

Two smaller pieces worth a look: **selective pixel escalation** (`pipeline/evidence-request.ts`) emits ranked crop requests with a padded, viewport-clipped rect and a typed reason (`small_or_dense_target`, `source_disagreement`, `parser_only_provenance`, `high_saliency`, `requested_refs`); degenerate or out-of-bounds targets come back as typed rejections rather than a misleading crop, and a crop covering most of the viewport falls back to requesting the full screenshot. And **bounded relations**: a spatial index generates candidates, and a per-node cap plus repeated-region summarization stops a 200-row table producing a quadratic edge set.

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
| A service, or a library? | A library inside the consumer's process — no network hop, no separate deployment |

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
packages/schema/            @apature/ui-graph — the whole library
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
  test/                     33 vitest files incl. property tests over the geometry kernel
schemas/                    normative JSON Schemas (snapshot, view, delta) + examples
                            — see schemas/README.md for versioning and reference loading
examples/quickstart.mjs     the runnable end-to-end example above
scripts/capability-guard.mjs the CI gate: dependency allowlist + determinism check
```

The JSON Schemas are the normative contract; the TypeScript types explain the same thing, and a mirror test fails if the two drift.

Source comments cite section numbers (`TRD §8.1`, `PRD §6.4`, `ARCHITECTURE §7`) from the original internal specifications. Those documents are not part of this release; the citations are left in place as provenance for where a rule came from.

## Development

```
$ pnpm test
 Test Files  33 passed (33)
      Tests  332 passed (332)
```

```sh
pnpm lint              # eslint, warnings fail
pnpm typecheck         # same tsc -b as pnpm build
pnpm guard:capability   # no model/browser/network/DB dependency; determinism on hashed paths
pnpm example           # node examples/quickstart.mjs
```

Those are exactly what `.github/workflows/ci.yml` runs. One file at a time:

```sh
npx vitest run packages/schema/test/query.test.ts
```

## Limitations

| Component | Status | Notes |
|---|---|---|
| Build pipeline (`buildUiGraph`) | Working | validate → normalize → fuse → hierarchy → relations → DNA → seal; covered by the quickstart |
| View dispatcher (`queryUiGraph`) | Working | All six view kinds; output validated against the normative view schema in tests |
| Lineage + `diff` | Working | Requires durable DOM attributes in the capture to match; abstains otherwise, by design |
| Typed deltas | Working | Hash-verified, fail-closed |
| Design-system projection | Partial | Token and numeric-scale matching only; component-family and embedding matching are out of scope |
| Capture producer | Not implemented | Bring your own. The target shape is `src/readprofile.ts`; `syntheticCapture()` in `src/eval/synthetic-page.ts` is a working generator to test against |
| `b4_full_graph` benchmark row | Partial | Serializes a pre-assembler composite, so it stays marked `diagnosticOnly` and the promotion gate refuses it |
| Model-dependent evaluation | Not implemented | Grounding recall, finding precision/recall and latency were to be supplied by the consumer's model runs, and never were |

Beyond that table:

- **Everything here was measured against synthetic fixtures.** No real browser capture, no real page, no real design system. The generator (`syntheticCapture()`) was written to be adversarially realistic — 130 nodes, deliberate DOM/accessibility disagreement, a redacted field, content below the fold — but it is still synthetic.
- **The promotion gates were never met.** `src/eval/` contains the machinery: frozen fixture sets, a deterministic benchmark runner, paired bootstrap confidence intervals, exact McNemar, and the original numeric thresholds pre-registered as constants (≥70% token reduction, ≥99.5% valid refs, ≥98% cross-snapshot match precision, ≤2pp finding-recall loss). The gate is fail-closed, so with the repo as it stands the verdict is "insufficient evidence", not "promote".
- **Token counts are estimates.** `⌈chars/4⌉` for text, a 16px-patch grid for images. Both are labelled `kind: "estimate"` in the code and are ports for model-native counters.
- **Component-family and embedding matching are out of scope.** They need the design system's `componentFamilies`, which the producer repository owned and which is not in this release.
- **Never ran in production.** The package was gated behind a feature flag with `useMode` defaulting to shadow or offline evaluation, pending the evaluation above.
- **No cross-repo links.** This was built alongside sibling repositories (a capture/judgment engine, a design-system extractor, a CI gate, an MCP server). Nothing here depends on any of them at build or run time, and not all of them are published, so none are linked from this README rather than risk a dead link.

## Contributing

The repository is archived. Pull requests are not accepted and issues are not monitored — **forking is the intended path**, and MIT means you need no permission and owe nothing back. [`CONTRIBUTING.md`](CONTRIBUTING.md) is retained because the ownership-boundary and determinism rules explain why the code is shaped the way it is; read it before changing anything on the hashed path.

## Security

No credentials are accepted anywhere in this package, and it opens no sockets. The parts that matter for anyone running it against real page content — the untrusted-content boundary, the fail-closed sensitivity handling, and what upstream redaction is assumed to have done already — are in [`SECURITY.md`](SECURITY.md). There will be no security patches; read it before pointing this at anything real.

## License

MIT. See [`LICENSE`](LICENSE).
