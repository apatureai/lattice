# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x (`main`) | Yes |
| older commits | No |

The project is pre-1.0 and there is a single supported line: the latest `main`. Fixes land there. If you are pinned to an older commit, the upgrade path is to move to `main`.

## Reporting a vulnerability

Please report privately, not in a public issue.

- GitHub private vulnerability reporting: <https://github.com/apatureai/lattice/security/advisories/new>

Include what you need to reproduce it: the input that triggers it, the version or commit, and what you believe the impact is. A minimal capture bundle or view spec is ideal, since the graph library is deterministic and JSON in, JSON out. For an issue in the capture adapter, a minimal HTML page is the equivalent.

What you can expect:

- An acknowledgement within 5 business days.
- An initial assessment, whether it is accepted, needs more information, or is out of scope, within 10 business days.
- If accepted, a fix on `main` and a published GitHub Security Advisory crediting you, unless you ask to stay anonymous.
- Please give 90 days before public disclosure, or less by agreement if a fix ships sooner.

There is no bug bounty or reward program. Reports are still appreciated.

## Scope

In scope: anything in this repository that can be triggered by the inputs it accepts. For `@apature/ui-graph` those are a capture bundle, a UI-DNA projection, a view spec and a delta; concretely that includes bypasses of the untrusted-content boundary, sensitive-text leaks into a rendered view, hash or canonicalization flaws that let two different snapshots collide or the same snapshot hash differently, delta application that produces partial state, and denial of service from a pathological but schema-valid input. For `@apature/ui-graph-capture` it also includes the page you point it at: a page that causes the adapter to emit content it was told to redact, to escape the node and text budgets, or to attribute a node to the wrong frame, is in scope.

Out of scope: vulnerabilities in Chromium itself, and in the consumer's artifact store or model. The graph library has no network, browser, model-inference or database capability, so classes of issue that require one of those are not reachable from it.

## Security properties, and their limits

Read this before pointing the library at real page content.

**Capability posture is enforced, not asserted.** By design the graph library (`@apature/ui-graph`) has no network, browser, model-inference or database capability. `scripts/capability-guard.mjs` runs in CI as `pnpm guard:capability`: it allowlists the core's runtime dependencies, rejects network and HTTP clients, browser and CDP drivers, inference SDKs and DB clients, and reads the core's source for imports of any of them, including Node's own networking built-ins and the capture package. If you fork and loosen that guard, you lose the property it protects.

**The capture adapter is where the capability lives, and it is a real one.** `@apature/ui-graph-capture` launches Chromium and loads a URL you give it. Treat it accordingly: it will fetch whatever that page fetches, run whatever scripts that page runs, and it inherits Chromium's threat model. It is a separate package with the browser as an optional peer dependency precisely so that nothing gains that capability by accident. Within it: no credential is ever accepted or read, cookies and storage state are not persisted between captures, it never clicks, types or submits, and screenshots are written to a path you name and referenced by path, never inlined as bytes.

**It parses untrusted input.** Capture evidence (DOM text, accessibility names, OCR output, parser labels) is attacker-influenceable page content. The library validates instances against the JSON Schemas in `packages/schema/schemas/` using `ajv`, and `packages/schema/src/pipeline/untrusted.ts` implements the prompt-injection defenses: page-derived text is wrapped in an explicit untrusted-content boundary, boundary-marker forgery is neutralized, and control characters are stripped. These are defense-in-depth measures against a specific threat model, not a guarantee. Input size and nesting limits are the host process's job, not this library's.

**The graph library does not redact; it withholds. The adapter can redact.** The contract assumes redaction already happened upstream: text reaching the graph builder is expected to arrive already-redacted, carrying redaction metadata and sensitivity labels. `captureUrl`'s `redactSelectors` (the CLI's `--redact`) is how you satisfy that at the producer: it resolves the selectors through the protocol, replaces the matched subtrees' text with a mask **in the capture bundle itself**, and lists every affected source id. Two limits to know: selectors resolve in the main frame only, so a subtree inside an iframe is not covered; and the mask is applied to text runs, so anything sensitive that is a durable attribute value (`id`, `href`, `name`, `data-testid`) still travels. The `queryUiGraph` view path additionally withholds the name and text of any node labelled `pii`, `secret`, `credential` or `redacted`, flags it `withheld:sensitive`, and fails closed if such text would survive into a rendered prompt view. But the builder will hash and store whatever you hand it. Feed it raw captures of a logged-in production app and secrets end up in snapshots, content hashes, and any artifact store you wire behind it. Redact at capture time.

**Nothing here handles auth or multi-tenancy.** Tenant isolation, artifact storage, retention, and access control belong to the consuming application and are not implemented in this repository.

**Dependencies.** The graph library's runtime dependency surface is two packages, `ajv` and `ajv-formats`. The capture adapter adds `playwright-core` as an optional peer, plus the Chromium binary it installs on request; neither is pulled in by depending on the graph library. `pnpm-lock.yaml` is committed so builds are reproducible. Run `pnpm audit` in your own environment as part of adopting this, the same as you would for any dependency.

**No external security review.** This code has not had a third-party security audit. If you are putting it in a path that handles sensitive page content, review it yourself first. Findings from that review are exactly the kind of report this policy is for.
