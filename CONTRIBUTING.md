# Contributing to UI Graph

## This project is archived

Apature has been wound down. This repository is published as a historical
snapshot of the work, under the MIT license. It is **not maintained**.

- Issues and pull requests may sit unread indefinitely. Do not expect review,
  and please do not treat silence as rejection — it is just absence.
- There will be no releases, no roadmap, and no security patches
  (see [SECURITY.md](SECURITY.md)).
- **Forking is the encouraged path.** MIT means you can take this, rename it,
  and do whatever you want with it. You do not need permission and you do not
  need to send anything back.

The rest of this file is kept because it is the fastest way to understand how
the code is meant to hold together. If you fork it and want to stay consistent
with its design, read on.

## Running the checks locally

Requirements:

- Node 24 (`.node-version`; the root `package.json` asks for `>=24`).
- pnpm 9.15.0 — declared via `packageManager`, so `corepack enable` will pick
  up the right version automatically.

```sh
pnpm install
pnpm lint        # eslint --max-warnings=0; warnings fail the build
pnpm typecheck   # tsc -b across the workspace project references
pnpm test        # vitest run
pnpm guard:capability
```

`pnpm build` is the same `tsc -b` invocation as `pnpm typecheck`; `pnpm clean`
removes the build outputs. These five commands are exactly what
`.github/workflows/ci.yml` runs, in that order — if they pass locally, CI passes.

The workspace has a single package, `packages/schema` (`@apature/ui-graph`).
Its only runtime dependencies are `ajv` and `ajv-formats`.

## Ownership boundary (the original non-negotiable)

`@apature/ui-graph` is a **deterministic, sandboxed library**. It converts
versioned capture evidence and an approved UI-DNA projection into an immutable,
content-addressed scene graph and renders bounded views. It has **no** model,
browser, sandbox, network, or database capability (`TRD.md` §2, §3.1;
`ARCHITECTURE.md` §1–§2). The capability guard (`pnpm guard:capability`)
enforces this mechanically.

UI Graph deliberately did **not** own — the consuming judgment engine did
(`ARCHITECTURE.md` §16):

- browser capture, screenshots, OCR, visual-parser inference, embeddings, model calls;
- the canonical UI-DNA schema, extraction, approval, or storage;
- browser actions, code changes, GitHub delivery, feedback storage, agent memory;
- evaluation execution and model/prompt promotion.

Anything needing those capabilities belonged in the consumer, not here. That
split is why this package is small enough to be useful on its own.

## Experiment framing

UI Graph was a **feature-flagged representation experiment** pending a
precision/grounding/cost/latency evaluation; it never graduated. Builds carry a
`useMode` of `offline_eval`, `shadow`, or `production`. Non-production modes
force every DNA match to `authoritative: false`, and `useMode` participates in
the content/cache key so shadow and production artifacts can never collide
(`TRD.md` §4.3, §5.2, §13). The unmet acceptance gates are listed in
[README.md](README.md).

## Determinism

Code on the hashed/canonical path (build, serialize, hash, view) must be
deterministic: no wall-clock, randomness, or locale-dependent formatting. Wall
time belongs only to `UIGraphBuildResult.diagnostics` and delta `createdAt`,
never to hashed snapshot fields (`TRD.md` §5.1, §8, §9.2). The capability guard
fails the build on a violation in those files.

## Adding a runtime dependency

Runtime dependencies of the published package are allowlisted in
`scripts/capability-guard.mjs`. A new dependency requires an explicit entry
with a justification. Network/HTTP clients, browser/CDP drivers,
model/inference SDKs, and DB clients are denied outright — that denial is the
point of the guard, not a formality.

## Schemas are normative

The schemas in `packages/schema/schemas/` (mirrored from the repo-root
`schemas/`) are the contract. TypeScript types explain the same contract; tests
assert that representative instances validate against the schemas, so the two
cannot drift silently. `packages/schema/schemas-baseline/` holds the frozen
copies used to detect breaking schema changes.
