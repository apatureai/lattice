/**
 * #18: executable schema-evolution rules + the CI baseline gate. The pinned
 * baselines under packages/schema/schemas-baseline/ are the evolution anchor:
 * any non-additive drift of a normative schema fails here unless the version
 * was bumped correctly and the baseline re-pinned in the same change.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkVersionBump,
  CURRENT_SCHEMA_MAJOR,
  diffJsonSchema,
  migrateToCurrentMajor,
  readerSupportsMajor,
  SCHEMA_VERSION,
  validateSnapshot,
  type UIGraphSnapshot,
} from "../src/index.js";

const load = (rel: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

const NORMATIVE = [
  "ui-graph-snapshot.schema.json",
  "ui-graph-view.schema.json",
  "ui-graph-delta.schema.json",
] as const;

describe("CI baseline gate: normative schemas cannot drift without the right bump (#18)", () => {
  for (const name of NORMATIVE) {
    it(`${name}: live schema vs pinned baseline classifies clean under ${SCHEMA_VERSION}`, () => {
      const live = load(`../../../schemas/${name}`);
      const baseline = load(`../schemas-baseline/${name}`);
      const verdict = checkVersionBump(SCHEMA_VERSION, SCHEMA_VERSION, diffJsonSchema(baseline, live));
      // Same version ⇒ only a no-change diff passes. Any additive or breaking
      // drift demands a bump + deliberate baseline re-pin in the same change.
      expect(verdict.ok, verdict.reason ?? "").toBe(true);
      expect(verdict.requires).toBe("none");
    });
  }
});

describe("change classification + bump rules (TRD §15.2)", () => {
  const base = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" }, kind: { enum: ["a", "b"] } },
  };

  it("patch: constraint clarification with no shape change requires nothing", () => {
    const verdict = checkVersionBump("1.0.0", "1.0.1", diffJsonSchema(base, structuredClone(base)));
    expect(verdict).toMatchObject({ ok: true, requires: "none" });
  });

  it("minor: a new optional standard field and an enum addition each require a minor bump", () => {
    const withOptional = structuredClone(base) as typeof base & { properties: Record<string, unknown> };
    withOptional.properties["note"] = { type: "string" };
    expect(checkVersionBump("1.0.0", "1.0.1", diffJsonSchema(base, withOptional))).toMatchObject({
      ok: false,
      requires: "minor",
    });
    expect(checkVersionBump("1.0.0", "1.1.0", diffJsonSchema(base, withOptional)).ok).toBe(true);

    const withEnum = structuredClone(base) as unknown as { properties: { kind: { enum: string[] } } };
    withEnum.properties.kind.enum.push("c");
    expect(checkVersionBump("1.0.0", "1.0.5", diffJsonSchema(base, withEnum))).toMatchObject({
      ok: false,
      requires: "minor", // enum additions need a minor + consumer fallback policy
    });
  });

  it("major guardrails: removal, rename, type change, required-tightening, pattern/identity change", () => {
    const removed = structuredClone(base) as { properties: Record<string, unknown> };
    delete removed.properties["kind"];
    expect(checkVersionBump("1.0.0", "1.4.0", diffJsonSchema(base, removed))).toMatchObject({ ok: false, requires: "major" });

    const typeChanged = structuredClone(base) as { properties: { id: { type: string } } };
    typeChanged.properties.id.type = "number";
    expect(checkVersionBump("1.0.0", "2.0.0", diffJsonSchema(base, typeChanged)).ok).toBe(true);

    const tightened = structuredClone(base) as typeof base & { required: string[]; properties: Record<string, unknown> };
    tightened.required = ["id", "kind"];
    expect(checkVersionBump("1.0.0", "1.9.0", diffJsonSchema(base, tightened))).toMatchObject({ ok: false, requires: "major" });

    const pattern = { type: "object", required: [], properties: { ref: { type: "string", pattern: "^ug:" } } };
    const patternChanged = { type: "object", required: [], properties: { ref: { type: "string", pattern: "^ref:" } } };
    expect(checkVersionBump("1.0.0", "1.1.0", diffJsonSchema(pattern, patternChanged))).toMatchObject({ ok: false, requires: "major" });
  });
});

describe("strict validators + support window + migration contract", () => {
  const sealed = load("./examples/minimal-snapshot.json") as UIGraphSnapshot;

  it("unknown standard fields and out-of-band enum values are rejected by the strict validator", () => {
    const unknownField = { ...structuredClone(sealed), vendorThing: true } as unknown as UIGraphSnapshot;
    expect(validateSnapshot(unknownField).valid).toBe(false);
    const badEnum = structuredClone(sealed) as unknown as { nodes: Array<{ kind: string }> };
    badEnum.nodes[0]!.kind = "made_up_kind";
    expect(validateSnapshot(badEnum as unknown as UIGraphSnapshot).valid).toBe(false);
  });

  it("readers support the current major and exactly one prior", () => {
    expect(readerSupportsMajor(CURRENT_SCHEMA_MAJOR)).toBe(true);
    expect(readerSupportsMajor(CURRENT_SCHEMA_MAJOR + 1)).toBe(false);
    expect(readerSupportsMajor(CURRENT_SCHEMA_MAJOR - 1)).toBe(CURRENT_SCHEMA_MAJOR - 1 >= 1);
    expect(readerSupportsMajor(-1)).toBe(false);
  });

  it("migration returns a NEW object, records source version, and never mutates the stored blob", () => {
    const frozen = structuredClone(sealed);
    Object.freeze(frozen);
    Object.freeze(frozen.nodes);
    const migrated = migrateToCurrentMajor(frozen);
    expect(migrated.snapshot).not.toBe(frozen); // new object, historical blob untouched
    expect(migrated.snapshot).toEqual(frozen); // identity migration under a single major
    expect(migrated.sourceSchemaVersion).toBe(frozen.schemaVersion);
    expect(migrated.migrated).toBe(false);
    expect(() => migrateToCurrentMajor({ schemaVersion: "9.0.0" })).toThrow(/outside the supported window/);
  });
});
