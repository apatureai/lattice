import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  validateSnapshot,
  validateView,
  validateDelta,
  formatErrors,
  type ValidationResult,
} from "@apature/ui-graph";

// The repo keeps normative artifacts in more than one place: the root
// `schemas/` directory is the single source of truth (schemas/README.md), the
// package vendors a byte-for-byte copy under `packages/schema/schemas/` so the
// published validator ships with them (validate.ts), and the tests exercise a
// copy of the example fixtures under `test/examples/`. CONTRIBUTING.md and the
// schema README assert these "cannot drift silently" — these tests turn that
// prose invariant into an enforced gate.

const readText = (url: URL): string => readFileSync(fileURLToPath(url), "utf8");
const readJson = (url: URL): unknown => JSON.parse(readText(url));

// Resolved from this test file so they hold regardless of the working directory.
const rootSchemaDir = new URL("../../../schemas/", import.meta.url);
const packageSchemaDir = new URL("../schemas/", import.meta.url);
const rootExampleDir = new URL("../../../schemas/examples/", import.meta.url);
const testExampleDir = new URL("./examples/", import.meta.url);

const SCHEMA_FILES = [
  "ui-graph-snapshot.schema.json",
  "ui-graph-view.schema.json",
  "ui-graph-delta.schema.json",
] as const;

// Maps each normative example fixture to the validator that must accept it.
const EXAMPLE_VALIDATORS: Record<string, (v: unknown) => ValidationResult<unknown>> = {
  "minimal-snapshot.json": validateSnapshot,
  "minimal-view.json": validateView,
  "minimal-delta.json": validateDelta,
};

describe("package schema mirror matches the normative root schemas", () => {
  it.each(SCHEMA_FILES)("%s is byte-identical to the root schema", (name) => {
    const root = readText(new URL(name, rootSchemaDir));
    const mirror = readText(new URL(name, packageSchemaDir));
    // The vendored copy is what the shipped validator loads; if it drifts from
    // the normative schema, validation silently diverges from the contract.
    expect(mirror).toBe(root);
  });
});

describe("normative example fixtures validate against the schemas", () => {
  it.each(Object.keys(EXAMPLE_VALIDATORS))("schemas/examples/%s is valid", (name) => {
    const validate = EXAMPLE_VALIDATORS[name];
    const r = validate(readJson(new URL(name, rootExampleDir)));
    expect(r.valid, r.valid ? "" : formatErrors(r.errors)).toBe(true);
  });
});

describe("example fixtures do not drift between root and test copies", () => {
  it.each(Object.keys(EXAMPLE_VALIDATORS))("%s matches the root fixture", (name) => {
    const root = readText(new URL(name, rootExampleDir));
    const testCopy = readText(new URL(name, testExampleDir));
    expect(testCopy).toBe(root);
  });
});
