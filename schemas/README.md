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

## Reference loading

The delta schema references definitions in the snapshot schema by canonical `$id`. Validators must register both schemas in the same local schema store; validation must not depend on fetching `schemas.apature.ai` over the network. (That host is not served; `$id` values are identifiers only.)

## Integrity

- Snapshot `contentHash` is the RFC 8785-compatible canonical JSON hash after removing only `snapshotId` and `contentHash`.
- View identity derives from snapshot hash and a normalized view-spec hash that includes renderer and tokenizer profiles.
- Delta application validates the base ID/hash, applies typed operations, validates the target schema, and recomputes the target hash.
