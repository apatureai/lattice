# Security Policy

## Status: archived and unmaintained

This repository is a public archive of a wound-down product. It is **not
maintained and receives no security support**.

| Version | Supported |
| ------- | --------- |
| all     | No        |

There is no maintained release line, no patch stream, and no advisory process.
Dependencies are frozen at their mid-2026 versions.

## Reporting a vulnerability

You can still report one, and it is appreciated. Just calibrate expectations.

Use GitHub private vulnerability reporting rather than a public issue:

- <https://github.com/apatureai/ui-graph/security/advisories/new>

Please do not open a public issue for anything exploitable, and please do not
email. There is **no bug bounty and no reward program**.

What you can expect: no response SLA, no commitment to investigate, no
commitment to ship a fix, and no commitment to publish an advisory. A report
that identifies something serious may result in a note added to the README so
that people who fork the code are warned. That is the realistic ceiling.

## If you are going to run this code

Read this section before pointing the library at anything real.

**Treat it as unreviewed third-party code.** It was written for one internal
consumer (Apature's judgment engine) and stopped being maintained in 2026. It
has never had an external security review. Do not run it against production
secrets, production credentials, or customer data without reviewing it
yourself first.

**Dependencies are stale.** `pnpm-lock.yaml` pins versions from 2026 that
likely have known CVEs by the time you read this. Run your own `pnpm audit`
and update before use. The lockfile is preserved for reproducibility of the
archive, not because it is safe.

**Capability posture: real, but only as strong as the guard.** By design this
package has no network, browser, model-inference, or database capability. That
is enforced mechanically by `scripts/capability-guard.mjs` (run in CI as
`pnpm guard:capability`), which allowlists runtime dependencies and rejects
network/HTTP clients, browser/CDP drivers, inference SDKs, and DB clients. If
your fork removes or loosens that guard, you lose the property it protects.

**It parses untrusted input.** Capture evidence (DOM text, accessibility
names, OCR output, parser labels) is attacker-influenceable page content. The
library validates instances against the JSON Schemas in
`packages/schema/schemas/` using `ajv`, and
`packages/schema/src/pipeline/untrusted.ts` implements the prompt-injection
defenses: page-derived text is wrapped in an explicit untrusted-content
boundary, boundary-marker forgery is neutralized, and control characters are
stripped. These are defense-in-depth measures against a specific threat model,
not a guarantee. Input size and nesting limits are the host process's job, not
this library's.

**It does not redact.** The contract assumes redaction already happened
upstream: text reaching the graph builder is supposed to arrive
already-redacted, carrying redaction metadata and sensitivity labels. The
`queryUiGraph` view path additionally withholds the name and text of any node
labelled `pii`, `secret`, `credential` or `redacted`, and flags it
`withheld:sensitive`. The library will fail closed when rendering a prompt view
if text labelled `pii`, `secret`, or `credential` would survive into the
output, but it will happily hash and store whatever you hand it. Feed it raw
captures of a logged-in production app and secrets end up in snapshots,
content hashes, and any artifact store you wire behind it.

**Nothing here handles auth or multi-tenancy.** Tenant isolation, artifact
storage, retention, and access control were the consumer's responsibility and
are not implemented in this repo.
