# Contributing to lattice

Contributions are welcome. Issues and pull requests are read and reviewed.

The fastest way to be useful is to pick something off the [Roadmap](README.md#roadmap) in the README. Every item there names the file you would touch. The capture adapter now ships (`packages/capture`), so the first run is a single `pnpm capture <url>`; the highest-value contribution today is roadmap item 1, hardening that adapter against the real pages listed there — each edge is a self-contained pull request.

## Setting up

Requirements:

- Node 24 (`.node-version`; the root `package.json` asks for `>=24`).
- pnpm 9.15.0, declared via `packageManager`, so `corepack enable` picks up the right version automatically.

```sh
git clone https://github.com/apatureai/lattice.git
cd lattice
pnpm install --frozen-lockfile
pnpm lint             # eslint --max-warnings=0; warnings fail the build
pnpm typecheck        # tsc -b across the workspace project references
pnpm test             # vitest run
pnpm guard:capability # capability + determinism gate
pnpm example          # node examples/quickstart.mjs, the end-to-end demo
```

Those five commands are exactly what `.github/workflows/ci.yml` runs, in that order. If they pass locally, CI passes. `pnpm build` is the same `tsc -b` invocation as `pnpm typecheck`; `pnpm clean` removes the build outputs.

A single test file:

```sh
npx vitest run packages/schema/test/query.test.ts
```

The test suite imports the library as `@apatureai/lattice`, aliased to `packages/schema/src` in `vitest.config.ts`, so tests run without a build step. `examples/quickstart.mjs` imports `packages/schema/dist/index.js` and does need `pnpm build` first.

`pnpm test` is hermetic: no browser, no network. The tests that need a real Chromium live under `packages/capture/test-browser/` and run separately:

```sh
pnpm build
pnpm browser:install    # one-time Chromium download
pnpm test:browser
```

They are a separate suite rather than conditionally skipped tests, so a green `pnpm test` never quietly means the browser tests did not run. If you change the capture adapter, run both, and re-record the frozen protocol payload with `node packages/capture/scripts/record-fixture.mjs` if the fixture page changed.

## What contributions are wanted

In rough order of value:

1. **Reports from real pages.** Every fusion heuristic in `pipeline/fuse.ts` was tuned against a synthetic generator. Run `pnpm capture <your url>` and read `out/snapshot.json`: if fusion joins two things it should not have, or splits one thing it should not have, that is a valuable issue even without a fix attached. Include the capture bundle if you can share it.
2. **Hardening the capture adapter** (`packages/capture`). Its known edges are listed as roadmap item 1 in the README, each self-contained. Anything that drives a browser belongs in that package and never in `packages/schema`: the capability guard denies browser and CDP drivers as dependencies of the core library, and greps its source for imports of them.
3. **Roadmap items 2 through 6**, all listed in the README with the relevant file named.
4. **Bug fixes with a failing test first.** A test that reproduces the bug and fails on `main` makes review fast.
5. **Documentation that makes the first hour easier.** If something in the README sent you the wrong way, say so.

Before starting anything large, open an issue describing the approach. That is not a formality: the determinism and capability rules below constrain the design space more than they look like they do, and it is better to find that out before you write the code.

## How pull requests get reviewed

- CI must be green: lint, typecheck, test, capability guard, example.
- New behaviour needs a test. New behaviour on the hashed path needs a determinism argument in the PR description.
- Review looks first at whether the change preserves the invariants below, then at the code.
- Small, focused pull requests get reviewed faster than large ones. If a change touches both the schemas and the pipeline, say why it has to.
- No AI attribution in commit messages.

## The invariants

These are the rules the codebase is built around. A change that breaks one of them is not necessarily wrong, but it needs an explicit argument.

### Capability boundary

`@apatureai/lattice` is a deterministic, sandboxed library. It converts versioned capture evidence and an approved UI-DNA projection into an immutable, content-addressed scene graph and renders bounded views. It has **no** model, browser, sandbox, network, or database capability. `pnpm guard:capability` enforces this mechanically.

The library deliberately does not own: browser capture, screenshots, OCR, visual-parser inference, embeddings, model calls; the canonical UI-DNA schema, its extraction, approval, or storage; browser actions, code changes, delivery, feedback storage, agent memory; evaluation execution and model or prompt promotion.

Anything needing those capabilities belongs in the consumer, or in a separate workspace package with its own dependencies. That split is why this package is small enough to be useful on its own, and why you can drop it into an agent without inheriting a browser.

### Determinism

Code on the hashed and canonical path (build, serialize, hash, view) must be deterministic: no wall-clock, no randomness, no locale-dependent formatting. Wall time belongs only to `UIGraphBuildResult.diagnostics` and delta `createdAt`, never to hashed snapshot fields. The capability guard fails the build on a violation in those files.

Sorting counts as part of that path, which is easy to miss. Candidate order decides ref ordinals, the winner of a tie between two claims is the string that gets sealed, and the order of a rendered list is view bytes, so every string comparison in the package must use `compareCodeUnits` from `canonical.ts`. `String.prototype.localeCompare` resolves against the process locale: `["z", "ä"]` comes back `ä, z` under `en-US` and `z, ä` under `sv-SE`, and a capture containing both sealed to two different content hashes on the same machine with `LC_ALL` changed. The capability guard denies the locale-sensitive APIs across the whole package, not only on the named hashed-path files.

The producer side has the same rule about paths. A `file:` URL is mostly a description of one machine, so `locationIndependentUrl` in `packages/capture` reduces it to its file name before anything derives a `captureId`, an `artifact://` ref, a route or a document url from it. Nothing that reaches a committed fixture or a sealed snapshot may name a directory on the machine that produced it.

The practical consequence: the same capture always produces the same `snapshotId`, and the same view spec against the same snapshot always produces byte-identical text. The quickstart pins a snapshot id in the README precisely so a determinism regression is visible immediately.

### `useMode`

Builds carry a `useMode` of `offline_eval`, `shadow`, or `production`. Non-production modes force every design-system match to `authoritative: false`, and `useMode` participates in the content and cache key, so shadow and production artifacts can never collide. Do not add a code path that bypasses this.

### Schemas are normative

The schemas in `packages/schema/schemas/` (mirrored from the repo-root `schemas/`) are the contract. TypeScript types explain the same contract; a mirror test asserts that representative instances validate against the schemas, so the two cannot drift silently. `packages/schema/schemas-baseline/` holds the frozen copies used to detect breaking schema changes, and `src/schema-evolution.ts` turns a schema diff into a version-bump verdict.

A schema change needs the version bump the evolution rules call for, plus compatibility fixtures for anything additive. See `schemas/README.md`.

### Adding a runtime dependency

Runtime dependencies of the core package are allowlisted in `scripts/capability-guard.mjs`. A new dependency requires an explicit entry with a justification. Network and HTTP clients, browser and CDP drivers, model and inference SDKs, and DB clients are denied outright. That denial is the point of the guard, not a formality.

The guard also reads the core's source for imports of anything in those categories, including Node's own networking built-ins and the capture package, because a workspace sibling resolves without ever appearing in a manifest. And it holds the capture package to its side of the line: its browser dependency must stay an optional peer, so that consuming the core, or the adapter's pure transform, never installs a browser.

## Style

- TypeScript, ESM, explicit `.js` extensions on relative imports (the project uses Node16-style module resolution across project references).
- The workspace has two packages: `packages/schema` (`@apatureai/lattice`), whose only runtime dependencies are `ajv` and `ajv-formats`, and `packages/capture` (`@apatureai/lattice-capture`), which depends on the core and takes `playwright-core` as an optional peer. The dependency is one-way and the guard enforces it.
- Comments explain why a rule exists, not what the line does. Several cite section numbers from earlier design documents; new code does not need to.
- No em dashes in prose.

## License

By contributing you agree that your contributions are licensed under the MIT license, the same terms as the rest of the repository.
