/**
 * Strict JSON Schema validation for the UI Graph contracts.
 *
 * The three normative schemas are registered in one local Ajv instance so the
 * delta schema can `$ref` the snapshot schema by canonical `$id` without any
 * network fetch (schemas/README.md "Reference loading"). All schemas are closed
 * (`additionalProperties: false`); unknown top-level or nested fields are
 * rejected.
 *
 * No network, model, browser, or DB access occurs here — only in-process JSON
 * validation (TRD §3.1).
 */

import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction, ErrorObject } from "ajv";
import addFormatsDefault from "ajv-formats";

// The schemas declare JSON Schema draft 2020-12 (`$schema`), so we use the
// 2020 Ajv build rather than the default draft-07 class.
type Ajv = Ajv2020;
// ajv-formats is a CJS module exporting the plugin both as `module.exports` and
// `.default`; under NodeNext interop the namespace import is the plugin fn.
const addFormats = addFormatsDefault as unknown as (ajv: Ajv) => Ajv;
import type { UIGraphSnapshot, UIGraphView, UIGraphDelta } from "./types.js";

const require = createRequire(import.meta.url);

// Schemas are vendored into the package and loaded from disk via resolveJsonModule
// would inline them into the bundle; instead we require the JSON so the files in
// `schemas/` remain the single source of truth shipped with the package.
const snapshotSchema = require("../schemas/ui-graph-snapshot.schema.json") as object;
const viewSchema = require("../schemas/ui-graph-view.schema.json") as object;
const deltaSchema = require("../schemas/ui-graph-delta.schema.json") as object;

export const SNAPSHOT_SCHEMA_ID = "https://schemas.apature.ai/ui-graph/snapshot/1.0.0";
export const VIEW_SCHEMA_ID = "https://schemas.apature.ai/ui-graph/view/1.0.0";
export const DELTA_SCHEMA_ID = "https://schemas.apature.ai/ui-graph/delta/1.0.0";

function buildAjv(): Ajv {
  // Ajv's `strict` mode lints schema *authoring* (e.g. flagging `if/then`
  // conditional subschemas that omit a redundant `type`/`required` echo). The
  // normative schemas use those valid JSON Schema 2020-12 constructs, so we
  // disable the authoring lint rather than mutate the normative artifact.
  // Instance-level strictness — rejection of unknown fields — comes from the
  // schemas' own `additionalProperties: false` and is fully enforced regardless.
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  // Register all schemas in one store so cross-schema $refs resolve locally.
  ajv.addSchema(snapshotSchema, SNAPSHOT_SCHEMA_ID);
  ajv.addSchema(viewSchema, VIEW_SCHEMA_ID);
  ajv.addSchema(deltaSchema, DELTA_SCHEMA_ID);
  return ajv;
}

const ajv = buildAjv();

const validateSnapshotFn = ajv.getSchema(SNAPSHOT_SCHEMA_ID) as ValidateFunction;
const validateViewFn = ajv.getSchema(VIEW_SCHEMA_ID) as ValidateFunction;
const validateDeltaFn = ajv.getSchema(DELTA_SCHEMA_ID) as ValidateFunction;

export type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; errors: ErrorObject[] };

function runValidator<T>(fn: ValidateFunction, value: unknown): ValidationResult<T> {
  if (fn(value)) {
    return { valid: true, value: value as T };
  }
  return { valid: false, errors: fn.errors ?? [] };
}

export function validateSnapshot(value: unknown): ValidationResult<UIGraphSnapshot> {
  return runValidator<UIGraphSnapshot>(validateSnapshotFn, value);
}

export function validateView(value: unknown): ValidationResult<UIGraphView> {
  return runValidator<UIGraphView>(validateViewFn, value);
}

export function validateDelta(value: unknown): ValidationResult<UIGraphDelta> {
  return runValidator<UIGraphDelta>(validateDeltaFn, value);
}

/** Human-readable single-line summary of validation errors, for diagnostics. */
export function formatErrors(errors: ErrorObject[]): string {
  return errors
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`)
    .join("; ");
}
