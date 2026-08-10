# ui-graph

**A scene graph for browser agents that keeps its sources honest.** It fuses DOM/layout, accessibility, computed style and text-run capture evidence into one immutable, content-addressed graph, then renders small budgeted text views of it for a model prompt.

The point of difference: when DOM says `link` and the accessibility tree says `button`, ui-graph does not pick a winner. It keeps both claims on the node, flags `conflict:role`, lowers confidence, and lets you decide whether to escalate to pixels. Every fact in a rendered view stays traceable to the source that produced it, through the same short ref the model was given.

It is a pure TypeScript library. JSON in, JSON out. No browser, no screenshots, no OCR, no model calls, no network, no database.

## Who this is for

- You are building a **browser agent or computer-use agent** and you already have a capture layer (CDP, Playwright, an extension, your own harness).
- Flat accessibility-tree serialization is not working for you: it is too big, it loses geometry, and it silently drops the disagreements that are the interesting part.
- You need the model's prompt to be **small and bounded**, and you need to know exactly what got dropped to make it fit.
- You need a claim the model makes about "that button" to resolve back to real evidence later, for a review comment, an assertion, or a human check.

If you want a turnkey "point it at a URL" tool, this is not that. ui-graph consumes capture evidence; producing it is your job today (see [Roadmap](#roadmap), item 1).

## Why it is interesting

Four ideas carry the design.

**No source is authoritative; sources are fused with provenance.** The accessibility tree knows roles and names. The layout tree knows geometry and clipping. Computed style knows typography and color. A visual parser or OCR (supplied from outside; this package never runs one) knows what is inside a `<canvas>`. Each is right about different things. `pipeline/fuse.ts` merges observations by explicit backend/source id where one exists, otherwise by frame plus geometric overlap plus role/text compatibility. Competence is decided **per fact**, never globally. Disagreement is retained as coexisting evidence claims with a conflict flag.

**Content-addressed identity with an acyclic reference scope.** A sealed snapshot is hashed with RFC 8785 (JSON Canonicalization Scheme), hand-written in `canonical.ts`: locale-independent key ordering, ECMAScript number production, `-0` normalized to `0`, NaN and Infinity rejected. Nodes carry short `elementRef` strings derived from a *ref-scope digest*, which is the snapshot hashed with the identity fields and the refs themselves removed. That breaks the obvious cycle (refs are in the content, the content determines the hash, the hash determines the refs). Refs are snapshot-local by construction, so a ref from another snapshot is refused with `stale_or_foreign_ref` rather than silently resolving to the wrong element.

**A matcher that abstains.** Cross-snapshot identity is a separate, explicitly probabilistic problem, kept apart on purpose. `diffUiGraphs` scores each base node against target candidates over weighted deterministic features and only reports `matched` when the best candidate clears a threshold *and* leads the runner-up. Otherwise it says `ambiguous` or `abstained`. A confidently wrong pointer is more damaging than a missing one.

**Views as a budgeted, fail-closed rendering problem.** Every view reports what it dropped: truncation flag, omitted node and edge counts, a token estimate, resolved and unresolved refs, and the policy version that produced it. Rendering is deterministic, so the same graph yields byte-identical text. Page-derived text is data, never instructions: it is wrapped in `<<<UNTRUSTED_UI_CONTENT>>>` markers, occurrences of those markers inside page text are neutralized so content cannot forge the boundary, and ASCII control characters are stripped. If sensitive text would survive into a prompt view, rendering throws instead of serializing the leak.

## Requirements

| Tool | Floor | Check |
|---|---|---|
| Node | v24 | `node -v  # need v24.x` |
| pnpm | 9.15.0 | `pnpm -v  # need 9.15.0` |

```sh
corepack enable          # installs the pnpm version pinned in package.json
```

Verified on macOS 15.6.1 and on `ubuntu-latest` in CI. Windows has not been tried. No command in this README requires credentials, API keys or network access, and none of them accepts any. Dependencies are pinned and `pnpm-lock.yaml` is committed, so `--frozen-lockfile` reproduces the verified tree exactly.

## Install

From a clean clone, at the repo root:

```sh
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` is `tsc -b` across the workspace project references. The quickstart imports the compiled output, so it needs this step; the test suite runs against `src` through a Vitest alias and does not.

## Quickstart

One command, no credentials, no browser. It generates a deterministic synthetic page capture (130 DOM nodes, 130 accessibility nodes, 93 text runs), builds a sealed snapshot, asks it five bounded questions, and shows what a tight token budget does to one of them.

```
$ node examples/quickstart.mjs
1. Synthetic capture (no browser was involved)
   route              /deployments  @ 1440x900 css px
   dom/layout nodes   130
   accessibility      130
   text runs          93
   canonical JSON     60637 bytes (15158 est. tokens)

2. buildUiGraph — fuse, hierarchy, relations, DNA projection, seal
   snapshotId         ugs_1_67401d2a3b0e3dbd1d34def5ba0e79d0dec33c1ff365c37c415161bbb0ce0d48
   contentHash        sha256:67401d2a3b0e3dbd1d34def5ba0e79d0dec33c1ff365c37c415161bbb0ce0d48
   nodes / edges      130 / 400
   regions            35
   retained conflicts 1   (DOM said "link", accessibility said "button" — both kept)
   canonical JSON     444253 bytes

3. queryUiGraph — five views of the same snapshot (focus/patchContext on ug:07ee97e8:2)
   view             bytes  est.tok  nodes  vs capture  truncation
   summary          31428     7857    118       48.2%  none
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
   ug:07ee97e8:10  link      Settings                  @ 0.53,0.03 (visible)
   ug:07ee97e8:2   button    New review                @ 0.88,0.02 (visible)
   ug:07ee97e8:20  link      Open production           @ 0.03,0.30 (visible)
   ug:07ee97e8:21  link      Open staging              @ 0.19,0.30 (visible)
   ug:07ee97e8:22  link      Open preview              @ 0.34,0.30 (visible)
   … 9 more

6. Compression with receipts — the view is lean, the provenance is not lost
   ug:07ee97e8:2 resolves in this snapshot: true
   evidence claims on that node: 4
     dom             conf 0.9   role=link, tag=a
     accessibility   conf 0.85   role=button, name=New review
     text_run        conf 0.8   text=New review
     computed_style  conf 0.9   style:backgroundColor, style:borderRadiusCssPx, style:color, style:fontSizeCssPx, style:spacing
   flags: conflict:role
   a ref from another snapshot is refused: stale_or_foreign_ref

7. patchContext requested 1 crop(s) — recommendations the caller may decline
   crop of artifact://apature/synthetic-dashboard/root.png
     rect 1240,0 200x78  refs ug:07ee97e8:2  because requested_refs,source_disagreement

8. Wrote out/capture.json, out/snapshot.json and 5 out/view-*.json files.

OK — built snapshot ugs_1_67401d2a3b0e3d… and rendered 5 schema-valid views.
```

**Success criterion:** the last line reads `OK — built snapshot … and rendered 5 schema-valid views.`, and `out/` contains seven JSON files (`capture.json`, `snapshot.json`, and `view-summary.json`, `view-actionMap.json`, `view-violations.json`, `view-focus.json`, `view-patchContext.json`). The snapshot id is content-addressed, so it will be byte-for-byte the one printed above. If yours differs, something is wrong.

Open `out/view-focus.json` to see what actually goes into a prompt, and `out/snapshot.json` to see the provenance that stayed behind.

If it exits with `ERR_MODULE_NOT_FOUND` and `Cannot find module '.../packages/schema/dist/index.js'`, you skipped `pnpm build`.

## Usage

Four entry points, all synchronous except the builder.

The package is not on npm yet (see [Roadmap](#roadmap), item 4). Inside this repo, tests import it as `@apature/ui-graph` (aliased to the source in `vitest.config.ts`) and plain Node scripts import the build directly, the way `examples/quickstart.mjs` does:

```js
import { buildUiGraph, queryUiGraph } from "./packages/schema/dist/index.js";
```

### `buildUiGraph(request) → { snapshot, diagnostics }`

```ts
import { buildUiGraph, syntheticCapture, syntheticDna } from "@apature/ui-graph";

const { snapshot, diagnostics } = await buildUiGraph({
  capture: syntheticCapture(),        // CaptureBundleReadProfile, see src/readprofile.ts
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

`useMode` participates in the deterministic input hash, so shadow and production artifacts can never collide, and any non-production mode forces every design-system match to `authoritative: false`. Failures are `UIGraphError` with a typed `code` (`invalid_build_options`, `invalid_capture`, `invalid_dna`, `invalid_snapshot`, `non_approved_dna_in_production`), never a partial snapshot.

### `queryUiGraph(request) → UIGraphView`

```ts
import { queryUiGraph } from "@apature/ui-graph";

const view = queryUiGraph({
  snapshot,
  spec: {
    kind: "focus",                    // summary | focus | actionMap | patchContext | violations | diff
    refs: ["ug:07ee97e8:2"],          // required for focus and patchContext
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

- **Refs are verified, never guessed.** A malformed ref is `invalid_view_spec`; a well-formed ref that is not a member of *this exact snapshot* (full `(snapshotId, contentHash)` tuple, exact membership, never a prefix match) is `stale_or_foreign_ref`.
- **`includeSensitive: false` is enforced here**, not assumed of the caller. Nodes labelled `pii`, `secret`, `credential` or `redacted` lose their name and text in the projection and are flagged `withheld:sensitive`. If sensitive text somehow survives to render time, the view throws rather than serialize the leak.
- **Budgets truncate; they never throw.** `maxNodes` and `maxEdges` bound the render directly. `maxTextTokens` is enforced by re-rendering with a deterministically halving node budget until it fits, and the reduction is reported in `truncation.reasons`.
- **Identity is derived.** `specHash` is the canonical hash of the normalized spec (renderer and tokenizer profiles included); `viewId` derives from the snapshot content hash and that spec hash. Same question, same id.
- `kind: "diff"` additionally requires `comparisonSnapshot` and a matching `comparisonSnapshotId` / `comparisonContentHash` in the spec.

### `diffUiGraphs(base, target) → UIGraphDiff`

Runs the abstaining lineage matcher directly. Each base node is scored against target candidates over weighted deterministic features: explicit id 0.35, name 0.20, role 0.15, geometry 0.15, region 0.10, kind 0.05. A node is `matched` only if the best candidate clears 0.7 *and* leads the runner-up by 0.1; two close candidates are `ambiguous`, a weak best is `abstained`, no candidate is `removed`.

The explicit-id feature reads durable DOM attributes (`data-testid`, `id`, `href`, `name`) that the capture reported under `attributes`. A capture that reports none cannot reach the match threshold at all, and the matcher will correctly abstain on everything. On the synthetic page, 44 of 130 nodes match and 86 abstain, which is exactly the split between the elements that carry a test id and the ones that do not.

### `applyUiGraphDelta(base, delta) → UIGraphSnapshot`

Deltas are ID-keyed typed operations bound to both `(snapshotId, contentHash)` tuples, with explicit (never cascading) incident-edge removal. Applying one recomputes the base identity from content (supplied fields are not trusted), applies ops in order, re-seals, and requires the reconstructed hash to equal the delta's declared target. Any failure is a typed error and *no* partial snapshot. Deltas are transport only; full snapshots stay canonical.

## Token efficiency

The claim is that this representation is cheaper to put in a prompt than raw structured context. Here is the measurement, with the baseline being canonical JSON bytes of the whole capture bundle.

| Capture | Nodes | Capture bytes | Summary view | Reduction |
|---|---|---|---|---|
| `test/fixtures/capture/minimal.json` | 1 | 738 | 403 | 45% |
| `test/fixtures/capture/multi-frame.json` | 4 | 1537 | 801 | 48% |
| `test/fixtures/capture/with-derived.json` | 3 | 1676 | 642 | 62% |
| `test/fixtures/capture/judgment-engine.golden.json` | 2 | 1758 | 647 | 63% |
| `syntheticCapture()` (the quickstart page) | 130 | 60637 | 31428 | 48% |

A page summary describes the whole page, so halving it is about the ceiling. The bounded views are where the design pays off, on the same synthetic page against the same 60637-byte baseline, with no token budget applied:

| View | Bytes | Est. tokens | Reduction vs capture |
|---|---|---|---|
| `patchContext` (1 ref) | 1439 | 360 | 97.6% |
| `actionMap` | 3394 | 849 | 94.4% |
| `focus` (1 ref, radius 2) | 4155 | 1039 | 93.1% |
| `violations` | 20355 | 5089 | 66.4% |
| `summary` | 31428 | 7857 | 48.2% |

The second table is exactly what `node examples/quickstart.mjs` prints; the first comes from `test/eval.synthetic-page.test.ts`, which re-derives it on every run. Read the numbers carefully:

- Token counts are `⌈chars/4⌉` estimates, clearly labelled as such throughout the code. They are ports; a real consumer injects model-native counters.
- The baseline is raw structured context only. It contains no image tokens, so this table is **not** a comparison against a screenshot-based prompt.
- The invariant "every view is smaller than its capture" is a test (`test/eval.synthetic-page.test.ts`). It fails the build if a future change reintroduces the regression that `views@2` fixed, when view text canonicalized whole fused nodes including the entire `evidence[]` chain and a summary came out *larger* than its input.
- Compression is not free of information. What is dropped is provenance the model cannot use, and it stays retrievable in the snapshot under the same ref the view emitted.

## Configuration

None. No environment variable is read anywhere in this repository; `grep -rn "process.env" packages scripts examples` returns nothing. Everything is a function argument.

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

- No browser, no screenshots, no OCR, no model calls, no network, no database. This is enforced in CI by `scripts/capability-guard.mjs`, not by convention.
- It never edits code and never drives a UI. `actionMap` is a *perception* view of observed affordances; it is not an action API.
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
packages/schema/            @apature/ui-graph, the whole library
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
                            (see schemas/README.md for versioning and reference loading)
examples/quickstart.mjs     the runnable end-to-end example above
scripts/capability-guard.mjs the CI gate: dependency allowlist + determinism check
```

The JSON Schemas are the normative contract; the TypeScript types explain the same thing, and a mirror test fails if the two drift.

Some source comments cite section numbers (`TRD §8.1`, `PRD §6.4`, `ARCHITECTURE §7`) from earlier design documents that are not part of this repository. They are left in place as provenance for where a rule came from.

## Status

Version 0.1.0. The core is working and covered by tests; the edges are honest about what is missing.

| Component | Status | Notes |
|---|---|---|
| Build pipeline (`buildUiGraph`) | Working | validate → normalize → fuse → hierarchy → relations → DNA → seal; covered by the quickstart |
| View dispatcher (`queryUiGraph`) | Working | All six view kinds; output validated against the normative view schema in tests |
| Lineage + `diff` | Working | Requires durable DOM attributes in the capture to match; abstains otherwise, by design |
| Typed deltas | Working | Hash-verified, fail-closed |
| Canonical JSON + sealing | Working | RFC 8785, property-tested geometry kernel |
| Design-system projection | Partial | Token and numeric-scale matching only; component-family and embedding matching are not implemented |
| Capture producer | **Not implemented** | Bring your own adapter. See roadmap item 1 |
| npm publish | Not done | The package is `private: true`. See roadmap item 4 |
| Model-dependent evaluation | Not run | Grounding recall, finding precision/recall and latency need a model consumer. See roadmap item 5 |

Two things to be clear about, because they change how you should read every number above:

- **Everything here was measured against synthetic fixtures.** No real browser capture, no real page, no real design system. `syntheticCapture()` was written to be adversarially realistic (130 nodes, a deliberate DOM/accessibility disagreement, a redacted field, content below the fold) but it is still synthetic. First contact with a real page is the most valuable contribution anyone could make right now.
- **The pre-registered promotion gates have not been met.** `src/eval/` contains the machinery: frozen fixture sets, a deterministic benchmark runner, paired bootstrap confidence intervals, exact McNemar, and the numeric thresholds as constants (at least 70% token reduction, at least 99.5% valid refs, at least 98% cross-snapshot match precision, at most 2pp finding-recall loss). The gate is fail-closed, so as the repo stands the verdict is "insufficient evidence", not "promote". That is the gate working, not a bug.

## Roadmap

These are the concrete, pickup-able items. Each names the file you would touch. Issues and pull requests are welcome for any of them.

**1. A built-in capture adapter (the big one).** ui-graph consumes capture evidence; producing it is up to you today. This is the single biggest thing standing between the library and a five-minute first run, so it is the most valuable contribution available.

The target shape is `CaptureBundleReadProfile` in `packages/schema/src/readprofile.ts`. An adapter has to fill roughly this:

```ts
type CaptureBundleReadProfile = {
  schemaVersion: "1.0.0";
  captureId: string;
  captureVersion: string;                    // e.g. "playwright-capture@1"
  repository: { owner: string; name: string };
  route: string;
  viewport: Viewport;                        // css px + deviceScaleFactor + scroll offsets
  documents: Array<{
    frameId: string;
    parentFrameId?: string;
    url?: string;
    transformToParent?: [number, number, number, number, number, number];
    domLayoutNodes: CaptureDomLayoutNode[];  // sourceId, parent, tag/role, bounds, visible,
                                             // paintOrder, styleFacts, durable attributes
    accessibilityNodes: CaptureAccessibilityNode[];  // role, name, state, backendDomSourceId
    textRuns?: CaptureTextRun[];
  }>;
  screenshotEvidence?: ScreenshotEvidenceRef[];      // by reference; no bytes enter this library
  pageHealth: { stable: boolean; partial: boolean; reasons: string[] };
  redaction: { policyVersion: string; applied: boolean; redactedSourceIds: string[] };
  derivedObservations?: DerivedObservation[];        // vision parser, OCR, embeddings, learned relations
};
```

A Playwright or CDP adapter maps `DOMSnapshot.captureSnapshot` plus `Accessibility.getFullAXTree` onto that. Two details that matter more than they look:

- **Set `backendDomSourceId` on accessibility nodes wherever the protocol gives it to you.** That is what lets fusion join by explicit id instead of falling back to geometric overlap, and it is what makes a role conflict a *retained conflict* rather than two unrelated nodes.
- **Collect the durable attributes** (`data-testid`, `id`, `href`, `name`) into `attributes`. Without them the lineage matcher has no explicit-id feature and can only abstain, as documented under `diffUiGraphs`.

To test an adapter without a browser, compare its output against `syntheticCapture()` in `packages/schema/src/eval/synthetic-page.ts`, and run it through `validateCapture` from the public API. The adapter belongs in a new workspace package, not in `packages/schema`: the capability guard denies browser and CDP drivers as runtime dependencies of the core library, and that boundary should hold.

**2. Component-family and embedding matching in the design-system projection.** `pipeline/dna-match.ts` matches design tokens and numeric scales today. Component families need the producer's `componentFamilies` shape in `readprofile.ts`, which is currently typed `unknown[]`. Embeddings would stay advisory by design: they retrieve candidates, they never make an authoritative match.

**3. Real model-native tokenizers.** Token counts are `⌈chars/4⌉` estimates, labelled `kind: "estimate"` in the code. The tokenizer profile is already a spec field (`tokenizerProfile: "char-quarter-estimate@1"`) and participates in `specHash`, so adding a real counter is a matter of registering a new profile, not reworking the renderer.

**4. Publish to npm.** The package is `private: true` and consumed by relative path. Getting it published means deciding the public export surface (`src/index.ts` currently exports the pipeline internals that the tests reach for) and wiring a release workflow.

**5. Close the `b4_full_graph` benchmark row.** It serializes a pre-assembler composite rather than a sealed snapshot, so it is marked `diagnosticOnly` and the promotion gate refuses to score it. Fixing it means routing that row through the real builder in `src/eval/`.

**6. First contact with a real page.** Run items 1 and 3 against an actual site, and report what the fusion layer gets wrong. Every fusion heuristic in `pipeline/fuse.ts` was tuned against a generator, which is exactly as circular as it sounds.

## Development

```
$ pnpm test
 Test Files  33 passed (33)
      Tests  332 passed (332)
```

```sh
pnpm lint              # eslint, warnings fail
pnpm typecheck         # same tsc -b as pnpm build
pnpm guard:capability  # no model/browser/network/DB dependency; determinism on hashed paths
pnpm example           # node examples/quickstart.mjs
```

Those are exactly what `.github/workflows/ci.yml` runs. One file at a time:

```sh
npx vitest run packages/schema/test/query.test.ts
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the conventions that matter, especially the determinism rules on the hashed path and the capability boundary.

## Security

No credentials are accepted anywhere in this package, and it opens no sockets. [`SECURITY.md`](SECURITY.md) covers what matters if you point this at real page content: the untrusted-content boundary, the fail-closed sensitivity handling, what upstream redaction is assumed to have done already, and how to report a vulnerability privately.

## License

MIT. See [`LICENSE`](LICENSE).
