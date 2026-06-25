# Contributing to UI Graph

## Ownership boundary (non-negotiable)

`@apature/ui-graph` is a **deterministic, sandboxed library**. It converts
versioned capture evidence and an approved UI-DNA projection into an immutable,
content-addressed scene graph and renders bounded views. It has **no** model,
browser, sandbox, network, or database capability (TRD §2, §3.1; ARCHITECTURE
§1–§2). The capability guard (`pnpm guard:capability`, run in CI) enforces this.

UI Graph **must not delegate to** — and Judgment Engine owns — the following
(ARCHITECTURE §16):

- browser capture, screenshots, OCR, visual-parser inference, embeddings, model calls;
- the canonical UI-DNA schema, extraction, approval, or storage;
- browser actions, code changes, GitHub delivery, feedback storage, agent memory;
- evaluation execution and model/prompt promotion.

If a change needs any of those, it belongs in the consumer, not here.

## Experiment framing

Per `apatureai/core` #103 DECISION 4, UI Graph is a **feature-flagged
representation experiment** until its precision/grounding/cost/latency eval
proves value. Builds carry a `useMode` of `offline_eval`, `shadow`, or
`production`. Non-production modes force every DNA match to
`authoritative: false`, and `useMode` participates in the content/cache key so
shadow and production artifacts never collide (TRD §4.3, §5.2, §13).

## Determinism

Code on the hashed/canonical path (build, serialize, hash, view) must be
deterministic: no wall-clock, randomness, or locale-dependent formatting. Wall
time belongs only to `UIGraphBuildResult.diagnostics` and delta `createdAt`,
never to hashed snapshot fields (TRD §5.1, §8, §9.2). The capability guard fails
the build on a violation in those files.

## Adding a runtime dependency

Runtime dependencies of the published package are allowlisted in
`scripts/capability-guard.mjs`. A new dependency requires an explicit entry with
a justification, reviewed in the PR. Network/HTTP clients, browser/CDP drivers,
model/inference SDKs, and DB clients are denied outright.

## Local checks

```sh
pnpm install
pnpm lint        # warnings fail the build
pnpm typecheck
pnpm test
pnpm guard:capability
```

The schemas in `packages/schema/schemas/` (mirrored from the repo-root
`schemas/`) are normative. TypeScript types explain the same contract; tests
assert representative instances validate against the schemas so the two cannot
drift silently.
