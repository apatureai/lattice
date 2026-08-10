# Contributing to lattice

Contributions are welcome. Issues and pull requests are read and reviewed.

The fastest way to be useful is to pick something off the [Roadmap](README.md#roadmap) in the README. Every item there names the file you would touch. Item 1, a built-in capture adapter, is the single highest-value contribution available: it is what stands between this library and a five-minute first run for a new user.

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

The test suite imports the library as `@apature/ui-graph`, aliased to `packages/schema/src` in `vitest.config.ts`, so tests run without a build step. `examples/quickstart.mjs` imports `packages/schema/dist/index.js` and does need `pnpm build` first.

## What contributions are wanted

In rough order of value:

1. **A capture adapter** (Playwright, CDP, an extension). See roadmap item 1 in the README for the target shape and the two details that matter most. This belongs in a new workspace package, not in `packages/schema`, because the capability guard denies browser and CDP drivers as runtime dependencies of the core library.
2. **Reports from real pages.** Every fusion heuristic in `pipeline/fuse.ts` was tuned against a synthetic generator. If you run this against a real site and fusion joins two things it should not have, or splits one thing it should not have, that is a valuable issue even without a fix attached. Include the capture bundle if you can share it.
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

`@apature/ui-graph` is a deterministic, sandboxed library. It converts versioned capture evidence and an approved UI-DNA projection into an immutable, content-addressed scene graph and renders bounded views. It has **no** model, browser, sandbox, network, or database capability. `pnpm guard:capability` enforces this mechanically.

The library deliberately does not own: browser capture, screenshots, OCR, visual-parser inference, embeddings, model calls; the canonical UI-DNA schema, its extraction, approval, or storage; browser actions, code changes, delivery, feedback storage, agent memory; evaluation execution and model or prompt promotion.

Anything needing those capabilities belongs in the consumer, or in a separate workspace package with its own dependencies. That split is why this package is small enough to be useful on its own, and why you can drop it into an agent without inheriting a browser.

### Determinism

Code on the hashed and canonical path (build, serialize, hash, view) must be deterministic: no wall-clock, no randomness, no locale-dependent formatting. Wall time belongs only to `UIGraphBuildResult.diagnostics` and delta `createdAt`, never to hashed snapshot fields. The capability guard fails the build on a violation in those files.

The practical consequence: the same capture always produces the same `snapshotId`, and the same view spec against the same snapshot always produces byte-identical text. The quickstart pins a snapshot id in the README precisely so a determinism regression is visible immediately.

### `useMode`

Builds carry a `useMode` of `offline_eval`, `shadow`, or `production`. Non-production modes force every design-system match to `authoritative: false`, and `useMode` participates in the content and cache key, so shadow and production artifacts can never collide. Do not add a code path that bypasses this.

### Schemas are normative

The schemas in `packages/schema/schemas/` (mirrored from the repo-root `schemas/`) are the contract. TypeScript types explain the same contract; a mirror test asserts that representative instances validate against the schemas, so the two cannot drift silently. `packages/schema/schemas-baseline/` holds the frozen copies used to detect breaking schema changes, and `src/schema-evolution.ts` turns a schema diff into a version-bump verdict.

A schema change needs the version bump the evolution rules call for, plus compatibility fixtures for anything additive. See `schemas/README.md`.

### Adding a runtime dependency

Runtime dependencies of the published package are allowlisted in `scripts/capability-guard.mjs`. A new dependency requires an explicit entry with a justification. Network and HTTP clients, browser and CDP drivers, model and inference SDKs, and DB clients are denied outright. That denial is the point of the guard, not a formality.

## Style

- TypeScript, ESM, explicit `.js` extensions on relative imports (the project uses Node16-style module resolution across project references).
- The workspace has a single package today, `packages/schema` (`@apature/ui-graph`), whose only runtime dependencies are `ajv` and `ajv-formats`.
- Comments explain why a rule exists, not what the line does. Several cite section numbers from earlier design documents; new code does not need to.
- No em dashes in prose.

## License

By contributing you agree that your contributions are licensed under the MIT license, the same terms as the rest of the repository.
