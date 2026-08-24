# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the two published packages — `@apatureai/lattice` (`packages/schema`) and
`@apatureai/lattice-capture` (`packages/capture`) — are versioned together and
share this file. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-08-24

The first release published to npm: `@apatureai/lattice` and
`@apatureai/lattice-capture` at 0.1.1. Version 0.1.0 was tagged before the
release automation and the scope rename existed, so it was never published.

### Added

- Release automation: `.github/workflows/release.yml` publishes both packages to
  npm on a `v*` tag, with [provenance](https://docs.npmjs.com/generating-provenance-statements).
  See the workflow header and the README "Publishing" section for the one-time
  maintainer setup (own the `@apatureai` npm scope, add the `NPM_TOKEN` secret).
- `examples/design-dna.json`: a runnable, adapter-valid UI-DNA graph projection
  an external producer can copy, pass to `pnpm capture --dna`, and adapt.
- README: a "Publishing" section, and a "Bring your own design system" subsection
  documenting the token-category vocabulary the `violations` view matches against
  and the `projectionSchemaVersion` requirement.

### Changed

- Packages renamed to the `@apatureai/*` scope: `@apature/ui-graph` →
  `@apatureai/lattice` and `@apature/ui-graph-capture` →
  `@apatureai/lattice-capture`. This is done before the first publish, so no
  released version is affected. The schema URNs (`urn:apatureai:ui-graph:...`)
  and on-disk schema filenames keep the `ui-graph` spelling as pinned identity.
- Both packages are now publishable: removed `private: true`, added
  `publishConfig` (`access: public`, `provenance`) and a `prepublishOnly` build.
  `packages/capture` depends on `packages/schema` via `workspace:*`, which
  `pnpm publish` rewrites to the concrete published version.

### Fixed

- The capture CLI now prints the underlying typed issues (code and path) when a
  build fails — for example an incompatible `--dna` profile — instead of only the
  bare top-line message, so an external DNA producer can see what to fix.

## [0.1.0] - 2026-08-10

Initial public release.

### Added

- `buildUiGraph(request)`: the deterministic build pipeline — validate,
  normalize, fuse, hierarchy, relations, DNA projection, seal — that fuses DOM,
  accessibility, style and text capture into one content-addressed snapshot
  (RFC 8785 canonical JSON, property-tested geometry kernel).
- `queryUiGraph(request)`: budgeted views over a sealed snapshot — `summary`,
  `actionMap`, `violations`, `focus`, `patchContext`, `full` — each validated
  against the normative view schema. Budgets truncate; they never throw.
- `diffUiGraphs` / `applyUiGraphDelta`: lineage matching and hash-verified,
  fail-closed typed deltas.
- `@apature/ui-graph-capture`: a Playwright/CDP capture adapter and the
  `lattice-capture` CLI that turns a real URL into a capture bundle the builder
  consumes, replacing per-session Chromium ids with capture-local ordinals so an
  unchanged page seals to a byte-identical snapshot.
- Design-system projection (`--dna`): token and numeric-scale matching against an
  approved UI-DNA graph projection, surfaced as the `violations` view.
- A no-browser `examples/quickstart.mjs` and a documented CLI quickstart, both
  covered end to end in CI.

### Known limitations

- The `violations` renderer is not yet budgeted and can exceed its own input on a
  poorly matching projection (roadmap item 2).
- Component-family and embedding matching in the projection are not implemented
  (roadmap item 3); token counts are `⌈chars/4⌉` estimates (roadmap item 4).
- Cross-process (OOPIF) iframes are reported in `pageHealth`, not retried.

[Unreleased]: https://github.com/apatureai/lattice/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/apatureai/lattice/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/apatureai/lattice/releases/tag/v0.1.0
