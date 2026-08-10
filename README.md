# lattice

[![CI](https://img.shields.io/github/actions/workflow/status/apatureai/lattice/ci.yml?branch=main&label=CI)](https://github.com/apatureai/lattice/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/github/license/apatureai/lattice)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](.node-version)

**A scene graph for browser agents that keeps its sources honest.** It fuses DOM/layout, accessibility, computed style and text-run capture evidence into one immutable, content-addressed graph, then renders small budgeted text views of it for a model prompt.

The point of difference: when DOM says `link` and the accessibility tree says `button`, lattice does not pick a winner. It keeps both claims on the node, flags `conflict:role`, lowers confidence, and lets you decide whether to escalate to pixels. Every fact in a rendered view stays traceable to the source that produced it, through the same short ref the model was given.

Point it at a URL:

```sh
pnpm capture https://example.com
```

Two packages, one boundary. **`@apature/ui-graph`** is the graph itself: a pure TypeScript library, JSON in, JSON out, with no browser, no screenshots, no OCR, no model calls, no network and no database. **`@apature/ui-graph-capture`** is the producer that feeds it: a Playwright/CDP adapter that turns a real page into the capture evidence the graph consumes. The browser lives in the adapter and nowhere else, and [`scripts/capability-guard.mjs`](scripts/capability-guard.mjs) fails CI if that ever stops being true.

## Who this is for

- You are building a **browser agent or computer-use agent**. Bring your own capture layer (CDP, Playwright, an extension, your own harness) or use the one in this repo.
- Flat accessibility-tree serialization is not working for you: it is too big, it loses geometry, and it silently drops the disagreements that are the interesting part.
- You need the model's prompt to be **small and bounded**, and you need to know exactly what got dropped to make it fit.
- You need a claim the model makes about "that button" to resolve back to real evidence later, for a review comment, an assertion, or a human check.

## Why it is interesting

Four ideas carry the design.

**No source is authoritative; sources are fused with provenance.** The accessibility tree knows roles and names. The layout tree knows geometry and clipping. Computed style knows typography and color. A visual parser or OCR (supplied from outside; this package never runs one) knows what is inside a `<canvas>`. Each is right about different things. `pipeline/fuse.ts` merges observations by explicit backend/source id where one exists, otherwise by frame plus geometric overlap plus role/text compatibility. Competence is decided **per fact**, never globally. Disagreement is retained as coexisting evidence claims with a conflict flag.

**Content-addressed identity with an acyclic reference scope.** A sealed snapshot is hashed with RFC 8785 (JSON Canonicalization Scheme), hand-written in `canonical.ts`: locale-independent key ordering, ECMAScript number production, `-0` normalized to `0`, NaN and Infinity rejected. Nodes carry short `elementRef` strings derived from a *ref-scope digest*, which is the snapshot hashed with the identity fields and the refs themselves removed. That breaks the obvious cycle (refs are in the content, the content determines the hash, the hash determines the refs). Refs are snapshot-local by construction, so a ref from another snapshot is refused with `stale_or_foreign_ref` rather than silently resolving to the wrong element.

**A matcher that abstains.** Cross-snapshot identity is a separate, explicitly probabilistic problem, kept apart on purpose. `diffUiGraphs` scores each base node against target candidates over weighted deterministic features and only reports `matched` when the best candidate clears a threshold *and* leads the runner-up. Otherwise it says `ambiguous` or `abstained`. A confidently wrong pointer is more damaging than a missing one.

**Views as a budgeted, fail-closed rendering problem.** Every view reports what it dropped: truncation flag, omitted node and edge counts, a token estimate, resolved and unresolved refs, and the policy version that produced it. Rendering is deterministic, so the same graph yields byte-identical text. Page-derived text is data, never instructions: it is wrapped in `<<<UNTRUSTED_UI_CONTENT>>>` markers, occurrences of those markers inside page text are neutralized so content cannot forge the boundary, and ASCII control characters are stripped. If sensitive text would survive into a prompt view, rendering throws instead of serializing the leak.

## Requirements

| Tool | Floor | Check | Needed for |
|---|---|---|---|
| Node | v24 | `node -v  # need v24.x` | everything |
| pnpm | 9.15.0 | `pnpm -v  # need 9.15.0` | everything |
| Chromium | the build `playwright-core` pins | `pnpm browser:install` | capturing a real page |

```sh
corepack enable          # installs the pnpm version pinned in package.json
```

Verified on macOS 15.6.1 and on `ubuntu-latest` in CI. Windows has not been tried. No command in this README requires credentials or API keys, and none of them accepts any. Dependencies are pinned and `pnpm-lock.yaml` is committed, so `--frozen-lockfile` reproduces the verified tree exactly.

Network is needed exactly twice: to install dependencies, and to fetch the Chromium binary once. After that, only the page you point the capture at is fetched. The graph library itself never opens a socket.

## Install

From a clean clone, at the repo root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm browser:install      # one-time Chromium download; skip it if you only want the library
```

`pnpm build` is `tsc -b` across the workspace project references. The CLI and the examples import the compiled output, so they need this step; the test suite runs against `src` through a Vitest alias and does not. `pnpm browser:install` is `playwright-core install chromium` scoped to the capture package; nothing downloads a browser implicitly.

## Quickstart: a URL in, a scene graph out

```
$ pnpm capture https://example.com
1. Capture (headless Chromium, DOMSnapshot + full accessibility tree over CDP)
   route              /  @ 1440x900 css px, dsf 1
   frames             1
   dom/layout nodes   7
   accessibility      8  (7 joined to a DOM node by backend id)
   text runs          3
   page health        stable=true partial=false
   redaction          applied=false  0 source id(s)
   canonical JSON     7080 bytes (1770 est. tokens)

2. buildUiGraph: fuse, hierarchy, relations, seal
   snapshotId         ugs_1_67992a572090dd60f90c4dd3d867b25d19eabd99fb3a4dc720fd5d7be82f116a
   contentHash        sha256:67992a572090dd60f90c4dd3d867b25d19eabd99fb3a4dc720fd5d7be82f116a
   nodes / edges      8 / 23
   regions            0
   retained conflicts 0   (sources that disagreed; both claims kept)
   canonical JSON     24386 bytes

3. queryUiGraph: 4 views of the same snapshot (focus/patchContext on ug:69ef0b08:6)
   view             bytes  est.tok  nodes  vs capture  truncation
   summary           1691      423      8       76.1%  none
   actionMap          367       92      1       94.8%  none
   focus             2929      733      7       58.6%  none
   patchContext      1421      356      1       79.9%  none
   ("vs capture" is the reduction against the canonical capture JSON above.)

4. actionMap: 1 perceivable affordances (perception only; never an action API)
   ug:69ef0b08:6   link      Learn more                @ 0.20,0.24 (visible)

5. Wrote out/capture.json, out/snapshot.json and 4 out/view-*.json files.

OK, captured https://example.com and built snapshot ugs_1_67992a572090dd… with 4 schema-valid views.
```

`example.com` is seven elements, which is the point: it fits on the page. Swap it for any `http(s)://` or `file://` URL. The repository ships a denser fixture page with landmarks, a table, a form, an iframe and two deliberate source disagreements:

```
$ pnpm capture "file://$PWD/packages/capture/test/fixtures/page.html" --route /deployments
1. Capture (headless Chromium, DOMSnapshot + full accessibility tree over CDP)
   route              /deployments  @ 1440x900 css px, dsf 1
   frames             2
   dom/layout nodes   74
   accessibility      79  (74 joined to a DOM node by backend id)
   text runs          47
   page health        stable=true partial=false
   redaction          applied=false  0 source id(s)
   canonical JSON     74916 bytes (18729 est. tokens)

2. buildUiGraph: fuse, hierarchy, relations, seal
   snapshotId         ugs_1_caed6c46470205c27effb5dd00fa83cb1d95228d72fdc8ef111bac01231d9cd1
   contentHash        sha256:caed6c46470205c27effb5dd00fa83cb1d95228d72fdc8ef111bac01231d9cd1
   nodes / edges      79 / 217
   regions            12
   retained conflicts 2   (sources that disagreed; both claims kept)
   canonical JSON     259538 bytes

3. queryUiGraph: 4 views of the same snapshot (focus/patchContext on ug:2f17bbf9:21)
   view             bytes  est.tok  nodes  vs capture  truncation
   summary           9756     2437     36       87.0%  none
   actionMap         2735      684     11       96.3%  none
   focus             4143     1036      6       94.5%  none
   patchContext      1516      379      1       98.0%  none
   ("vs capture" is the reduction against the canonical capture JSON above.)

4. actionMap: 11 perceivable affordances (perception only; never an action API)
   ug:2f17bbf9:21  link      Open production           @ 0.03,0.31 (visible)
   ug:2f17bbf9:22  link      Open preview              @ 0.36,0.31 (visible)
   ug:2f17bbf9:23  link      Open staging              @ 0.19,0.33 (visible)
   ug:2f17bbf9:3   button    New review                @ 0.90,0.02 (visible)
   ug:2f17bbf9:5   link      Apature                   @ 0.02,0.03 (visible)
   … 6 more

5. Wrote out/capture.json, out/snapshot.json and 4 out/view-*.json files.

OK, captured file:///home/you/lattice/packages/capture/test/fixtures/page.html and built snapshot ugs_1_caed6c46470205… with 4 schema-valid views.
```

**Success criterion:** the last line reads `OK, captured <your url> and built snapshot … with N schema-valid views.`, and `out/` contains `capture.json`, `snapshot.json` and one `view-*.json` per view. Open `out/view-actionMap.json` to see what a model would be told about the page, and `out/capture.json` to see the evidence it was told from.

Two things worth noticing in that output, because they are what this repository is actually about.

**"74 joined to a DOM node by backend id."** The adapter reads `DOMSnapshot.captureSnapshot` and `Accessibility.getFullAXTree`, both keyed by the same backend node id, so fusion joins the two trees by explicit id rather than guessing from overlapping rectangles. That is what makes "retained conflicts 2" meaningful: on the fixture page a detached `<li>` and a `<summary>` disclosure widget are places where the DOM's implicit role and the accessibility tree genuinely disagree, and both claims survive onto one node instead of one of them quietly winning.

**The same page seals to the same `contentHash`.** Chromium's frame ids, backend node ids and accessibility node ids are per-session values that change on every launch. If they reached the bundle, an unchanged page would produce a new `snapshotId` every capture, which is the exact property content addressing exists to provide. The adapter replaces them with capture-local ordinals, so two separate browser launches over the same page produce a byte-identical capture. A live test asserts precisely that. The id does still move across platforms, because text metrics do; treat it as stable for a given page, browser build and machine, not as a universal fingerprint.

### Capture options

```
$ pnpm capture --help
lattice-capture <url> [options]

  --out <dir>           where to write artifacts (default ./out)
  --viewport <WxH>      viewport in CSS pixels (default 1440x900)
  --dsf <n>             device scale factor (default 1)
  --wait-for <selector> wait for this selector before capturing
  --settle <ms>         quiet time after load and fonts (default 300)
  --scroll-to <X,Y>     scroll to this offset before capturing
  --redact <selector>   redact this subtree at the producer; repeatable
  --repo <owner/name>   repository recorded on the capture
  --route <path>        route recorded on the capture (default the URL path)
  --max-nodes <n>       DOM node cap; exceeding it marks the capture partial (default 4000)
  --dna <file>          a UI-DNA graph projection to match against, enabling the violations view
  --screenshot          also save a viewport screenshot and reference it
  --dark                emulate prefers-color-scheme: dark
  --headed              run with a visible browser window
  --capture-only        stop after the capture bundle; do not build a graph
  --json                print the capture bundle to stdout and write nothing
  -h, --help            show this message

Needs a browser once:  pnpm browser:install
                       (that is: pnpm exec playwright-core install chromium)
```

`--redact` is worth calling out. It resolves the selector through the protocol, replaces the matched subtree's text with a mask **in the capture bundle itself**, and lists every affected source id, so the sensitive text never enters the graph at all and lattice additionally flags those nodes and withholds them at render time. Form field values (`<input value>`, `<textarea>` contents) are never captured under any setting.

## Quickstart without a browser

One command, no credentials, no browser, nothing installed beyond Node. It generates a deterministic synthetic page capture (130 DOM nodes, 130 accessibility nodes, 93 text runs), builds a sealed snapshot, asks it five bounded questions, and shows what a tight token budget does to one of them.

```
$ node examples/quickstart.mjs
1. Synthetic capture (no browser was involved)
   route              /deployments  @ 1440x900 css px
   dom/layout nodes   130
   accessibility      130
   text runs          93
   canonical JSON     60637 bytes (15158 est. tokens)

2. buildUiGraph — fuse, hierarchy, relations, DNA projection, seal
   snapshotId         ugs_1_b12a4c602d4a0071e387206fb6f939c51b4e1b2ed1a22c4669bf6e3d978105a6
   contentHash        sha256:b12a4c602d4a0071e387206fb6f939c51b4e1b2ed1a22c4669bf6e3d978105a6
   nodes / edges      130 / 400
   regions            35
   retained conflicts 1   (DOM said "link", accessibility said "button" — both kept)
   canonical JSON     444253 bytes

3. queryUiGraph — five views of the same snapshot (focus/patchContext on ug:65bc9d34:2)
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
   ug:65bc9d34:10  link      Settings                  @ 0.53,0.03 (visible)
   ug:65bc9d34:2   button    New review                @ 0.88,0.02 (visible)
   ug:65bc9d34:20  link      Open production           @ 0.03,0.30 (visible)
   ug:65bc9d34:21  link      Open staging              @ 0.19,0.30 (visible)
   ug:65bc9d34:22  link      Open preview              @ 0.34,0.30 (visible)
   … 9 more

6. Compression with receipts — the view is lean, the provenance is not lost
   ug:65bc9d34:2 resolves in this snapshot: true
   evidence claims on that node: 4
     dom             conf 0.9   role=link, tag=a
     accessibility   conf 0.85   role=button, name=New review
     text_run        conf 0.8   text=New review
     computed_style  conf 0.9   style:backgroundColor, style:borderRadiusCssPx, style:color, style:fontSizeCssPx, style:spacing
   flags: conflict:role
   a ref from another snapshot is refused: stale_or_foreign_ref

7. patchContext requested 1 crop(s) — recommendations the caller may decline
   crop of artifact://example/synthetic-dashboard/root.png
     rect 1240,0 200x78  refs ug:65bc9d34:2  because requested_refs,source_disagreement

8. Wrote out/capture.json, out/snapshot.json and 5 out/view-*.json files.

OK — built snapshot ugs_1_b12a4c602d4a00… and rendered 5 schema-valid views.
```

**Success criterion:** the last line reads `OK — built snapshot … and rendered 5 schema-valid views.`, and `out/` contains seven JSON files (`capture.json`, `snapshot.json`, and `view-summary.json`, `view-actionMap.json`, `view-violations.json`, `view-focus.json`, `view-patchContext.json`). The snapshot id is content-addressed, so it will be byte-for-byte the one printed above. If yours differs, something is wrong.

Open `out/view-focus.json` to see what actually goes into a prompt, and `out/snapshot.json` to see the provenance that stayed behind.

If it exits with `ERR_MODULE_NOT_FOUND` and `Cannot find module '.../packages/schema/dist/index.js'`, you skipped `pnpm build`.

## Usage

Four graph entry points, all synchronous except the builder, plus three capture entry points.

The repository is `lattice`; it was renamed from `ui-graph`. The package identifier `@apature/ui-graph`, the schema URNs (`urn:apatureai:ui-graph:...`) and the on-disk schema filenames deliberately keep the old spelling, because those are pinned identity for anything that consumes this library, and renaming them would be a breaking change with no reader benefit.

The package is not on npm yet (see [Roadmap](#roadmap), item 5). Inside this repo, tests import it as `@apature/ui-graph` (aliased to the source in `vitest.config.ts`) and plain Node scripts import the build directly, the way `examples/quickstart.mjs` does:

```js
import { buildUiGraph, queryUiGraph } from "./packages/schema/dist/index.js";
```

### Capture: `captureUrl`, `captureFromPage`, `captureBundleFromCdp`

Three layers, each usable on its own, in `@apature/ui-graph-capture`.

```ts
import { captureUrl } from "@apature/ui-graph-capture";

const capture = await captureUrl("https://example.com/deployments", {
  viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  waitForSelector: "[data-testid='deployments-table']",
  redactSelectors: ["[data-sensitive]"],
  screenshotPath: "out/shot.png",
  repository: { owner: "acme", name: "console" },
});
// -> CaptureBundleReadProfile, ready for buildUiGraph
```

`captureFromPage(page, options)` does the same from a Playwright `Page` you already own, which is the one you want for an authenticated session or a page halfway through a flow. It is typed structurally, so this package never imports Playwright's types and never appears in your dependency graph as a browser.

`captureBundleFromCdp({ domSnapshot, axNodes, page, options })` is the whole adapter as a **pure function**: the two protocol payloads in, the read profile out, no browser, no clock, no randomness. That is what makes the adapter testable without a browser, and it is the seam to reuse if you drive CDP yourself (puppeteer, a raw WebSocket, a recorded session).

What the adapter does, and what it deliberately does not:

| | |
|---|---|
| Joins accessibility to DOM by `backendNodeId` | So fusion uses explicit ids, not geometric guessing |
| Reads every frame's accessibility tree, not just the main one | `getFullAXTree` returns one document at a time |
| Recombines a wrapped paragraph's line boxes into one text run | Otherwise ordinary wrapping reads as a text conflict |
| Collects `data-testid`, `id`, `href`, `name` | The four durable attributes the lineage matcher needs |
| Probes layout twice and reports `pageHealth.stable` | A moving page is reported, never silently captured |
| Replaces per-session protocol ids with capture-local ordinals | So an unchanged page seals to the same `contentHash` |
| Never captures form field values | `<input value>` and `<textarea>` content never enter the bundle |
| Never captures `display:none` subtrees by default | `includeNonRendered` opts in |
| Never sends bytes of a screenshot into the graph | Screenshots are referenced by path, as evidence |

Known limits, none of them hidden: `--redact` selectors resolve in the main frame only; a child frame's `transformToParent` is the iframe's border box, which is off by any border or padding on the iframe element; the DOM-side role mapping is a documented subset of HTML-AAM that abstains where a role is contextual (`<header>`, an unnamed `<section>`); and a cross-process iframe whose accessibility tree the protocol refuses is reported as a page-health reason rather than retried.

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
    refs: ["ug:65bc9d34:2"],          // required for focus and patchContext
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

### Real captures

Three pages captured through `pnpm capture`, on 2026-08-10, at 1440x900. The two live sites move; re-run the command and you will get different numbers, which is why the reproducible fixture page is in the middle row.

| Page | DOM nodes | Capture bytes | `summary` | `actionMap` | `focus` | `patchContext` |
|---|---|---|---|---|---|---|
| `https://example.com` | 7 | 7080 | 1691 (76.1%) | 367 (94.8%) | 2929 (58.6%) | 1421 (79.9%) |
| the bundled fixture page | 74 | 74916 | 9756 (87.0%) | 2735 (96.3%) | 4143 (94.5%) | 1516 (98.0%) |
| `https://news.ycombinator.com` | 806 | 745445 | 61098 (91.8%) | 53942 (92.8%) | 8355 (98.9%) | 1467 (99.8%) |

Read these more carefully than the headline percentages invite.

- **The baseline is a verbose capture.** The adapter records 23 computed style properties per node, because the point of the graph is to keep evidence rather than pre-decide what matters. That inflates the denominator and therefore every reduction figure. Against a leaner capture, the same view would look less impressive; the honest comparison is the *view* against whatever structured context you would otherwise have pasted into the prompt.
- **A bounded view scales, a page summary does not.** `patchContext` about one element costs roughly the same 1.5 KB whether the page has 7 nodes or 806. `summary` grows with the page, which is why the smallest page shows the worst summary ratio and the largest shows the best.
- **`focus` on `example.com` is worse than its summary.** With eight nodes on the page, describing one node plus its neighbourhood is most of the page, plus per-view fixed overhead. Bounded views pay off on pages that have something to bound.
- **The `violations` view is missing from that table, and running it exposed a real problem.** It needs a design-system projection, so it only appears with `--dna`. Pointing the fixture page at the synthetic projection in `packages/schema/test/fixtures/dna/approved.json` (a projection that describes a different design system, so almost everything is a finding) produced a 91909-byte view against a 74916-byte capture: **larger than its own input**, and truncated at the node budget. The library has a test asserting every view is smaller than its capture, but that test runs on synthetic fixtures where the projection matches. It does not hold here. See roadmap item 2.

### Synthetic fixtures

| Capture | Nodes | Capture bytes | Summary view | Reduction |
|---|---|---|---|---|
| `test/fixtures/capture/minimal.json` | 1 | 738 | 403 | 45% |
| `test/fixtures/capture/multi-frame.json` | 4 | 1537 | 801 | 48% |
| `test/fixtures/capture/with-derived.json` | 3 | 1676 | 642 | 62% |
| `test/fixtures/capture/verdict.golden.json` | 2 | 1758 | 647 | 63% |
| `syntheticCapture()` (the quickstart page) | 130 | 60637 | 31428 | 48% |

`verdict.golden.json` is named for the consumer whose capture step produced its shape, the sibling repo [apatureai/verdict](https://github.com/apatureai/verdict). It is frozen JSON like the other three; nothing in this package depends on that repo.

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

None. No environment variable is read anywhere in this repository; `grep -rn "process.env" packages scripts examples` returns nothing. Everything is a function argument, or a `pnpm capture` flag.

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
packages/capture/           @apature/ui-graph-capture, the producer: a real page in
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

The JSON Schemas are the normative contract; the TypeScript types explain the same thing, and a mirror test fails if the two drift. Each schema is identified by a URN (`urn:apatureai:ui-graph:snapshot:1.0.0` and its view/delta siblings) rather than a URL, so nothing implies a fetchable endpoint and validation is provably offline. See [`schemas/README.md`](schemas/README.md).

The source calls its caller **the consumer**: whatever critique pipeline links this library in and owns the parts it deliberately does not, which is capture, inference, storage, delivery, and redaction. The reference consumer is the sibling repo [apatureai/verdict](https://github.com/apatureai/verdict), a grounded vision-language design reviewer. This package neither depends on it nor requires it; any pipeline that supplies the documented read profiles is a consumer.

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
| `violations` view size | Known defect | On a real capture with a poorly matching projection it exceeds its own input. See roadmap item 2 |
| Capture producer (`captureUrl`) | Working | Playwright/CDP adapter in `packages/capture`; covered by a frozen-payload suite and a live-browser suite |
| Capture: cross-process iframes | Partial | An OOPIF whose accessibility tree CDP refuses is reported in `pageHealth.reasons`, not retried |
| npm publish | Not done | Both packages are `private: true`. See roadmap item 5 |
| Model-dependent evaluation | Not run | Grounding recall, finding precision/recall and latency need a model consumer; the gates below stay fail-closed until one supplies runs |

Three things to be clear about, because they change how you should read every number above:

- **The fusion heuristics were still tuned against a generator.** `pipeline/fuse.ts` was written against `syntheticCapture()`, and the capture adapter is new. Real pages now go through it (the table above was measured on three), and the first two things a real page exposed were both adapter bugs, not library bugs: a wrapped paragraph read as a text conflict, and the accessibility tree's `StaticText` leaves entered the graph as geometry-less duplicates. Both are fixed and pinned by tests. Assume there are more; reporting one is the most valuable contribution available.
- **No real design system has been through this.** Every `violations` number in this README is from a synthetic UI-DNA projection. `--dna` accepts a real one, and nobody has supplied one yet.
- **The pre-registered promotion gates have not been met.** `src/eval/` contains the machinery: frozen fixture sets, a deterministic benchmark runner, paired bootstrap confidence intervals, exact McNemar, and the numeric thresholds as constants (at least 70% token reduction, at least 99.5% valid refs, at least 98% cross-snapshot match precision, at most 2pp finding-recall loss). The gate is fail-closed, so as the repo stands the verdict is "insufficient evidence", not "promote". That is the gate working, not a bug.

## Roadmap

These are the concrete, pickup-able items. Each names the file you would touch. Issues and pull requests are welcome for any of them.

**1. Harden the capture adapter against real pages.** It works (`packages/capture/src/transform.ts`) and it has known edges, each of which is a self-contained pull request:

- **Cross-process iframes.** `Accessibility.getFullAXTree` refuses an OOPIF from the parent session; today that becomes a `pageHealth` reason. The fix is a CDP session per target, via `Target.attachToTarget`.
- **Iframe offsets ignore the iframe's own border and padding.** `transformToParent` is the border box of the `<iframe>` element, so a framed document's geometry is off by whatever border and padding that element carries. The numbers to add are already in `styleFacts`.
- **The DOM-side role mapping is a subset** (`packages/capture/src/roles.ts`), and it abstains where a role is contextual: `<header>`, `<footer>`, an unnamed `<section>`, cells in a grid rather than a table. Resolving those needs the ancestor chain, which the flat pass has.
- **Shadow DOM and `<canvas>`.** `captureSnapshot` is called without `pierce`, so a closed shadow root's contents are not captured, and canvas contents never are by design (`derivedObservations` is where a vision parser's reading of a canvas belongs).
- **Scroll containers.** A capture is one scroll position. Stitching several into one snapshot, with the geometry to prove it, is unimplemented.

**2. The `violations` renderer does not stay under its own input.** On a real capture with a design-system projection that matches poorly, it emits more bytes than the capture it summarizes (see the note under Token efficiency: 91909 bytes of view from a 74916-byte capture). Every other view holds the invariant. The per-node conformance detail in `pipeline/views.ts` needs the same budgeting discipline the rest of the renderer already has, and `test/eval.synthetic-page.test.ts` needs a case where the projection deliberately does not match.

**3. Component-family and embedding matching in the design-system projection.** `pipeline/dna-match.ts` matches design tokens and numeric scales today. Component families need the producer's `componentFamilies` shape in `readprofile.ts`, which is currently typed `unknown[]`. Embeddings would stay advisory by design: they retrieve candidates, they never make an authoritative match.

**4. Real model-native tokenizers.** Token counts are `⌈chars/4⌉` estimates, labelled `kind: "estimate"` in the code. The tokenizer profile is already a spec field (`tokenizerProfile: "char-quarter-estimate@1"`) and participates in `specHash`, so adding a real counter is a matter of registering a new profile, not reworking the renderer.

**5. Publish to npm.** Both packages are `private: true` and consumed by workspace path. Getting them published means deciding the public export surface (`src/index.ts` currently exports the pipeline internals that the tests reach for) and wiring a release workflow.

**6. Close the `b4_full_graph` benchmark row.** It serializes a pre-assembler composite rather than a sealed snapshot, so it is marked `diagnosticOnly` and the promotion gate refuses to score it. Fixing it means routing that row through the real builder in `src/eval/`.

**7. Report what fusion gets wrong on your pages.** `pnpm capture <your url>` and read `out/snapshot.json`. Every fusion heuristic in `pipeline/fuse.ts` was tuned against a generator, which is exactly as circular as it sounds; the adapter is what makes that checkable, and two rounds of checking it have already produced two fixes.

## Development

```
$ pnpm test
 Test Files  35 passed (35)
      Tests  369 passed (369)

$ pnpm test:browser
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

```sh
pnpm lint              # eslint, warnings fail
pnpm typecheck         # same tsc -b as pnpm build
pnpm test              # hermetic: no browser, no network
pnpm guard:capability  # dependency + import boundary; determinism on hashed paths
pnpm example           # node examples/quickstart.mjs
pnpm browser:install   # one-time Chromium download, needed only for the next two
pnpm test:browser      # the live suite: real Chromium, real page
pnpm capture <url>     # the documented quickstart
```

`pnpm test` never needs a browser: the capture adapter is tested against a frozen protocol payload in `packages/capture/test/fixtures/cdp-recording.json`, re-recordable with `node packages/capture/scripts/record-fixture.mjs`. The live suite is separate rather than conditionally skipped, so a green `pnpm test` never quietly means "the browser tests did not run". `.github/workflows/ci.yml` runs both, in two jobs.

One file at a time:

```sh
npx vitest run packages/schema/test/query.test.ts
npx vitest run packages/capture/test/transform.test.ts
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the conventions that matter, especially the determinism rules on the hashed path and the capability boundary.

## Security

No credentials are accepted anywhere in either package. The graph library opens no sockets; the capture adapter opens exactly the ones the page you named opens, in a browser it launches and closes, with no persisted cookies or storage state. [`SECURITY.md`](SECURITY.md) covers what matters if you point this at real page content: the untrusted-content boundary, the fail-closed sensitivity handling, what `--redact` does and does not cover, and how to report a vulnerability privately.

## License

MIT. See [`LICENSE`](LICENSE).
