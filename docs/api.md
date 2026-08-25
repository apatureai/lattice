Part of [lattice](../README.md). Moved from the README on 2026-08-24; anchors preserved.

## Usage

Four graph entry points, all synchronous except the builder, plus three capture entry points.

The repository is `lattice`; it was renamed from `ui-graph`, and its packages now publish under the `@apatureai` scope (`@apatureai/lattice` and `@apatureai/lattice-capture`). The schema URNs (`urn:apatureai:ui-graph:...`) and the on-disk schema filenames deliberately keep the old `ui-graph` spelling, because those are pinned identity for anything that consumes this library, and renaming them would be a breaking change with no reader benefit.

The packages are published to npm at 0.1.1 (see [Publishing](development.md)). Inside this repo, tests import it as `@apatureai/lattice` (aliased to the source in `vitest.config.ts`) and plain Node scripts import the build directly, the way `examples/quickstart.mjs` does:

```js
import { buildUiGraph, queryUiGraph } from "./packages/schema/dist/index.js";
```

### Capture: `captureUrl`, `captureFromPage`, `captureBundleFromCdp`

Three layers, each usable on its own, in `@apatureai/lattice-capture`.

```ts
import { captureUrl } from "@apatureai/lattice-capture";

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

`screenshotPath` says where the PNG is written; it is **not** what goes into the bundle. The bundle records a logical `artifact://capture/<captureId>/<frameId>/screenshot.png` ref, minted by the exported `screenshotArtifactRef(captureId, frameId)`. Two reasons, both load-bearing: an absolute local path is machine-specific, so it would break the byte-identical capture the row above promises, and the normative view schema admits only `^artifact://[A-Za-z0-9._:/-]+$` for the `sourceArtifactRef` an evidence request carries. Pass that ref to `queryUiGraph` as `screenshotArtifactRef` and resolve it to bytes in your own storage; `queryUiGraph` refuses any other shape rather than emitting a view that fails its own published schema.

What the adapter does, and what it deliberately does not:

| | |
|---|---|
| Joins accessibility to DOM by `backendNodeId` | So fusion uses explicit ids, not geometric guessing |
| Reads every frame's accessibility tree, not just the main one | `getFullAXTree` returns one document at a time |
| Recombines a wrapped paragraph's line boxes into one text run | Otherwise ordinary wrapping reads as a text conflict |
| Collects `data-testid`, `id`, `href`, `name` | The four durable attributes the lineage matcher needs |
| Probes layout twice and reports `pageHealth.stable` | A moving page is reported, never silently captured |
| Replaces per-session protocol ids with capture-local ordinals | So an unchanged page seals to the same `contentHash` |
| Records a `file:` URL by its file name, not its directory | The path above it names a checkout, not the page |
| Never captures form field values | `<input value>` and `<textarea>` content never enter the bundle |
| Never captures `display:none` subtrees by default | `includeNonRendered` opts in |
| Never sends bytes of a screenshot into the graph | Screenshots are referenced by a logical `artifact://` ref, as evidence |

Known limits, none of them hidden: `--redact` selectors resolve in the main frame only; a child frame's `transformToParent` is the iframe's border box, which is off by any border or padding on the iframe element; the DOM-side role mapping is a documented subset of HTML-AAM that abstains where a role is contextual (`<header>`, an unnamed `<section>`); and a cross-process iframe whose accessibility tree the protocol refuses is reported as a page-health reason rather than retried.

### `buildUiGraph(request) → { snapshot, diagnostics }`

```ts
import { buildUiGraph, syntheticCapture, syntheticDna } from "@apatureai/lattice";

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

### Bring your own design system (the `--dna` path)

`syntheticDna()` above is a test fixture. To judge a real page against a real design system, pass a **UI-DNA graph projection** as `dna` (in code) or `--dna <file>` (on the CLI). The repository ships a copyable, adapter-valid one at [`examples/design-dna.json`](../examples/design-dna.json):

```sh
pnpm capture "file://$PWD/packages/capture/test/fixtures/page.html" --dna examples/design-dna.json
```

That enables the `violations` view, which reports every node whose observed style drifts from the nearest approved token. The projection is a subset schema — lattice validates only the fields it reads — but three fields decide whether it is accepted at all:

- **`projectionSchemaVersion`** is a semver whose **major must be `"1"`** (e.g. `"1.0.0"`). It is *not* the string `"dna-projection@1"`: that value is the builder's `dnaProjectionVersion` **policy label** (a different field, echoed into the snapshot spec), and using it as a schema version is rejected as `unsupported_source_major`.
- **`state`** must be `"approved"` for a match to be authoritative in a `"production"` build. An `"experimental"` profile is accepted only when it also declares `useMode` `"offline_eval"` or `"shadow"`, and every match it produces is forced `authoritative: false`.
- **`tokens`** is a map of `{ value, category, confidence }`. Only four `category` values are matched today, and a token in any other category is ignored:

  | `category` | Matched against | `value` shape |
  |---|---|---|
  | `color` | `color`, `backgroundColor` | a CSS color string, e.g. `"#1b6ef3"` |
  | `typography` | `fontSizeCssPx`, `lineHeightCssPx` | a number of CSS px, e.g. `14` |
  | `radii` | each `borderRadiusCssPx` | a number of CSS px, e.g. `8` |
  | `spacing` | each `spacing.*` value | a number of CSS px, e.g. `12` |

If a profile is rejected, `pnpm capture --dna` now prints the typed issues (code and JSON path) and a one-line hint, so you can see exactly which field to fix rather than a bare "incompatible".

Two honest limits. Every token value in `examples/design-dna.json` is calibrated to the synthetic page, so pointing it at an unrelated real page will report drift on almost everything — replace the values with your system's before reading the output as signal. And on a poorly matching projection the `violations` view is not yet budgeted and can exceed its own input (the run above emits ~91 KB of view; see [Roadmap](roadmap.md) item 2). Both are known; neither blocks trying the path.

### `queryUiGraph(request) → UIGraphView`

```ts
import { queryUiGraph } from "@apatureai/lattice";

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
