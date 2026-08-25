Part of [lattice](../README.md). Moved from the README on 2026-08-24; anchors preserved.

## Why it is interesting

Four ideas carry the design.

**No source is authoritative; sources are fused with provenance.** The accessibility tree knows roles and names. The layout tree knows geometry and clipping. Computed style knows typography and color. A visual parser or OCR (supplied from outside; this package never runs one) knows what is inside a `<canvas>`. Each is right about different things. `pipeline/fuse.ts` merges observations by explicit backend/source id where one exists, otherwise by frame plus geometric overlap plus role/text compatibility. Competence is decided **per fact**, never globally. Disagreement is retained as coexisting evidence claims with a conflict flag.

**Content-addressed identity with an acyclic reference scope.** A sealed snapshot is hashed with RFC 8785 (JSON Canonicalization Scheme), hand-written in `canonical.ts`: locale-independent key ordering, ECMAScript number production, `-0` normalized to `0`, NaN and Infinity rejected. Nodes carry short `elementRef` strings derived from a *ref-scope digest*, which is the snapshot hashed with the identity fields and the refs themselves removed. That breaks the obvious cycle (refs are in the content, the content determines the hash, the hash determines the refs). Refs are snapshot-local by construction, so a ref from another snapshot is refused with `stale_or_foreign_ref` rather than silently resolving to the wrong element.

**A matcher that abstains.** Cross-snapshot identity is a separate, explicitly probabilistic problem, kept apart on purpose. `diffUiGraphs` scores each base node against target candidates over weighted deterministic features and only reports `matched` when the best candidate clears a threshold *and* leads the runner-up. Otherwise it says `ambiguous` or `abstained`. A confidently wrong pointer is more damaging than a missing one.

**Views as a budgeted, fail-closed rendering problem.** Every view reports what it dropped: truncation flag, omitted node and edge counts, a token estimate, resolved and unresolved refs, and the policy version that produced it. Rendering is deterministic, so the same graph yields byte-identical text. Page-derived text is data, never instructions: it is wrapped in `<<<UNTRUSTED_UI_CONTENT>>>` markers, occurrences of those markers inside page text are neutralized so content cannot forge the boundary, and ASCII control characters are stripped. If sensitive text would survive into a prompt view, rendering throws instead of serializing the leak.
