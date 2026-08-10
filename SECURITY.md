# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x (`main`) | Yes |
| older commits | No |

The project is pre-1.0 and there is a single supported line: the latest `main`. Fixes land there. If you are pinned to an older commit, the upgrade path is to move to `main`.

## Reporting a vulnerability

Please report privately, not in a public issue.

- GitHub private vulnerability reporting: <https://github.com/apatureai/ui-graph/security/advisories/new>

Include what you need to reproduce it: the input that triggers it, the version or commit, and what you believe the impact is. A minimal capture bundle or view spec is ideal, since this library is deterministic and JSON in, JSON out.

What you can expect:

- An acknowledgement within 5 business days.
- An initial assessment, whether it is accepted, needs more information, or is out of scope, within 10 business days.
- If accepted, a fix on `main` and a published GitHub Security Advisory crediting you, unless you ask to stay anonymous.
- Please give 90 days before public disclosure, or less by agreement if a fix ships sooner.

There is no bug bounty or reward program. Reports are still appreciated.

## Scope

In scope: anything in this repository that can be triggered by the inputs the library accepts, which are a capture bundle, a UI-DNA projection, a view spec, and a delta. Concretely that includes bypasses of the untrusted-content boundary, sensitive-text leaks into a rendered view, hash or canonicalization flaws that let two different snapshots collide or the same snapshot hash differently, delta application that produces partial state, and denial of service from a pathological but schema-valid input.

Out of scope: vulnerabilities in the consumer's browser, capture layer, artifact store, or model. This library has no network, browser, model-inference, or database capability, so classes of issue that require one of those are not reachable from here.

## Security properties, and their limits

Read this before pointing the library at real page content.

**Capability posture is enforced, not asserted.** By design this package has no network, browser, model-inference, or database capability. `scripts/capability-guard.mjs` runs in CI as `pnpm guard:capability`, allowlists runtime dependencies, and rejects network and HTTP clients, browser and CDP drivers, inference SDKs, and DB clients. If you fork and loosen that guard, you lose the property it protects.

**It parses untrusted input.** Capture evidence (DOM text, accessibility names, OCR output, parser labels) is attacker-influenceable page content. The library validates instances against the JSON Schemas in `packages/schema/schemas/` using `ajv`, and `packages/schema/src/pipeline/untrusted.ts` implements the prompt-injection defenses: page-derived text is wrapped in an explicit untrusted-content boundary, boundary-marker forgery is neutralized, and control characters are stripped. These are defense-in-depth measures against a specific threat model, not a guarantee. Input size and nesting limits are the host process's job, not this library's.

**It does not redact; it withholds.** The contract assumes redaction already happened upstream: text reaching the graph builder is expected to arrive already-redacted, carrying redaction metadata and sensitivity labels. The `queryUiGraph` view path additionally withholds the name and text of any node labelled `pii`, `secret`, `credential` or `redacted`, flags it `withheld:sensitive`, and fails closed if such text would survive into a rendered prompt view. But the builder will hash and store whatever you hand it. Feed it raw captures of a logged-in production app and secrets end up in snapshots, content hashes, and any artifact store you wire behind it. Redact at capture time.

**Nothing here handles auth or multi-tenancy.** Tenant isolation, artifact storage, retention, and access control belong to the consuming application and are not implemented in this repository.

**Dependencies.** The runtime dependency surface is two packages, `ajv` and `ajv-formats`. `pnpm-lock.yaml` is committed so builds are reproducible. Run `pnpm audit` in your own environment as part of adopting this, the same as you would for any dependency.

**No external security review.** This code has not had a third-party security audit. If you are putting it in a path that handles sensitive page content, review it yourself first. Findings from that review are exactly the kind of report this policy is for.
