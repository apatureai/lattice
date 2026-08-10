# UI Graph Schemas

Status: normative contracts at schema version 1.0.0. These are the source of truth; the TypeScript types in `packages/schema/src/types.ts` mirror them, and a test fails if the two drift.

## Contracts

- `ui-graph-snapshot.schema.json`: immutable canonical `UIGraphSnapshot`.
- `ui-graph-view.schema.json`: deterministic budgeted `UIGraphView`.
- `ui-graph-delta.schema.json`: typed transport delta between full snapshots.
- `examples/`: minimal validation fixtures, not semantic hash test vectors.

All schemas use JSON Schema Draft 2020-12 and are closed with `additionalProperties: false`. Namespaced experimental data belongs under `extensions` using keys such as `vendor.example/feature`.

## Versioning

- Patch: constraint clarification that does not change accepted instances.
- Minor: additive standard fields or enum values with explicit negotiation and compatibility fixtures.
- Major: required-field, type, identity, hash, coordinate, ref-scope, or edge-semantic changes.

Readers validate the exact supported schema ID. They do not silently ignore unknown standard fields.

## Schema identifiers

Each schema is identified by a URN, not a URL:

| Contract | `$id` |
| --- | --- |
| snapshot | `urn:apatureai:ui-graph:snapshot:1.0.0` |
| view | `urn:apatureai:ui-graph:view:1.0.0` |
| delta | `urn:apatureai:ui-graph:delta:1.0.0` |

A URN is deliberate: these are names, not locations, and nothing about them suggests a fetchable endpoint. The bytes they name live in this directory and are vendored byte-for-byte into `packages/schema/schemas/`, which is what the shipped validator loads. The `apatureai` namespace is the GitHub organization that owns them (<https://github.com/apatureai/ui-graph>).

Earlier revisions used `https://schemas.apature.ai/ui-graph/...` `$id` values. That host was never served, so the URLs implied a resolvable location that did not exist; the URNs replace them one for one. The identifier is the only thing that changed. No accepted instance shape moved, which is why the schema version stays at 1.0.0 and the evolution gate in `packages/schema/test/schema-evolution.test.ts` classifies the change as `none`.

## Reference loading

The delta schema references definitions in the snapshot schema by canonical `$id`. Validators must register both schemas in the same local schema store. Validation performs no network access at all, by construction: a URN has nothing to fetch.

## Integrity

- Snapshot `contentHash` is the RFC 8785-compatible canonical JSON hash after removing only `snapshotId` and `contentHash`.
- View identity derives from snapshot hash and a normalized view-spec hash that includes renderer and tokenizer profiles.
- Delta application validates the base ID/hash, applies typed operations, validates the target schema, and recomputes the target hash.
