Part of [lattice](../README.md). Moved from the README on 2026-08-24; anchors preserved.

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
| npm publish | Publish-ready, not yet published | Both packages are public with `publishConfig` + provenance and a `prepublishOnly` build; `.github/workflows/release.yml` publishes on a `v*` tag. Awaits the maintainer owning the `@apatureai` npm scope and adding `NPM_TOKEN`. See [Publishing](development.md) |
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

**2. The `violations` renderer does not stay under its own input.** On a real capture with a design-system projection that matches poorly, it emits more bytes than the capture it summarizes (see the note under Token efficiency: 91909 bytes of view from a 74740-byte capture). Every other view holds the invariant. The per-node conformance detail in `pipeline/views.ts` needs the same budgeting discipline the rest of the renderer already has, and `test/eval.synthetic-page.test.ts` needs a case where the projection deliberately does not match.

**3. Component-family and embedding matching in the design-system projection.** `pipeline/dna-match.ts` matches design tokens and numeric scales today. Component families need the producer's `componentFamilies` shape in `readprofile.ts`, which is currently typed `unknown[]`. Embeddings would stay advisory by design: they retrieve candidates, they never make an authoritative match.

**4. Real model-native tokenizers.** Token counts are `⌈chars/4⌉` estimates, labelled `kind: "estimate"` in the code. The tokenizer profile is already a spec field (`tokenizerProfile: "char-quarter-estimate@1"`) and participates in `specHash`, so adding a real counter is a matter of registering a new profile, not reworking the renderer.

**5. Tighten the public export surface before the first publish.** The packaging is done — both packages are public, carry `publishConfig` + provenance, and `.github/workflows/release.yml` publishes them on a `v*` tag (see [Publishing](development.md)). What is left is a judgment call, not plumbing: `src/index.ts` currently re-exports pipeline internals that the tests reach for, so the first tagged release should decide which of those are supported API and which should move behind a `./internal` subpath.

**6. Close the `b4_full_graph` benchmark row.** It serializes a pre-assembler composite rather than a sealed snapshot, so it is marked `diagnosticOnly` and the promotion gate refuses to score it. Fixing it means routing that row through the real builder in `src/eval/`.

**7. Report what fusion gets wrong on your pages.** `pnpm capture <your url>` and read `out/snapshot.json`. Every fusion heuristic in `pipeline/fuse.ts` was tuned against a generator, which is exactly as circular as it sounds; the adapter is what makes that checkable, and two rounds of checking it have already produced two fixes.
