/**
 * Schema-evolution + dual-major compatibility rules (#18; TRD §9.3, §15.2).
 *
 * The three normative schemas are closed (`additionalProperties: false`) and
 * versioned; this module makes the evolution RULES executable:
 *
 *  - `diffJsonSchema` classifies a schema change: breaking (major), additive
 *    (minor: new optional standard fields and enum additions both require a
 *    minor bump plus consumer fallback), or none (patch: constraint
 *    clarifications that change no accepted instance shape).
 *  - `checkVersionBump` gates a change against the declared version delta;
 *    the CI baseline test (schema-evolution.test.ts) applies it to the pinned
 *    baselines, so a normative schema cannot drift without the right bump.
 *  - Reader support window: current major and one prior, nothing else.
 *  - `migrateToCurrentMajor` is the migration contract: it NEVER mutates the
 *    stored blob, returns a NEW snapshot object, and records the source
 *    schema version. With only major 1 in existence it is the identity
 *    migration; the first real major bump must extend it (the baseline gate
 *    forces that conversation).
 *
 * Vendor/experimental data policy (enforced on introduction): such data may
 * only ever appear under a namespaced top-level `extensions` object added via
 * a minor bump, never as loose standard fields (the strict validators reject
 * unknown standard fields today, which is itself a tested invariant).
 */

import { SCHEMA_VERSION } from "./types.js";

export type SchemaChangeKind =
  | "added_optional_property"
  | "added_enum_value"
  | "added_required_property"
  | "removed_property"
  | "removed_enum_value"
  | "type_changed"
  | "const_changed"
  | "property_made_required"
  | "pattern_changed";

export interface SchemaChange {
  kind: SchemaChangeKind;
  path: string;
}

const BREAKING: ReadonlySet<SchemaChangeKind> = new Set([
  "added_required_property",
  "removed_property",
  "removed_enum_value",
  "type_changed",
  "const_changed",
  "property_made_required",
  "pattern_changed",
]);

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

/** Structural diff over the JSON-Schema subset the normative schemas use. */
export function diffJsonSchema(base: unknown, next: unknown, path = "#"): SchemaChange[] {
  if (!isNode(base) || !isNode(next)) return [];
  const changes: SchemaChange[] = [];

  if (JSON.stringify(base["type"]) !== JSON.stringify(next["type"])) {
    changes.push({ kind: "type_changed", path });
  }
  if ("const" in base || "const" in next) {
    if (JSON.stringify(base["const"]) !== JSON.stringify(next["const"])) {
      changes.push({ kind: "const_changed", path });
    }
  }
  if ("pattern" in base || "pattern" in next) {
    if (base["pattern"] !== next["pattern"]) changes.push({ kind: "pattern_changed", path });
  }

  const baseEnum = Array.isArray(base["enum"]) ? (base["enum"] as unknown[]) : null;
  const nextEnum = Array.isArray(next["enum"]) ? (next["enum"] as unknown[]) : null;
  if (baseEnum && nextEnum) {
    const baseSet = new Set(baseEnum.map((v) => JSON.stringify(v)));
    const nextSet = new Set(nextEnum.map((v) => JSON.stringify(v)));
    for (const value of baseSet) if (!nextSet.has(value)) changes.push({ kind: "removed_enum_value", path });
    for (const value of nextSet) if (!baseSet.has(value)) changes.push({ kind: "added_enum_value", path });
  }

  const baseRequired = new Set(Array.isArray(base["required"]) ? (base["required"] as string[]) : []);
  const nextRequired = new Set(Array.isArray(next["required"]) ? (next["required"] as string[]) : []);
  const baseProps = isNode(base["properties"]) ? (base["properties"] as Node) : {};
  const nextProps = isNode(next["properties"]) ? (next["properties"] as Node) : {};

  for (const key of Object.keys(baseProps)) {
    if (!(key in nextProps)) {
      changes.push({ kind: "removed_property", path: `${path}/properties/${key}` });
    } else {
      changes.push(...diffJsonSchema(baseProps[key], nextProps[key], `${path}/properties/${key}`));
      if (!baseRequired.has(key) && nextRequired.has(key)) {
        changes.push({ kind: "property_made_required", path: `${path}/properties/${key}` });
      }
    }
  }
  for (const key of Object.keys(nextProps)) {
    if (!(key in baseProps)) {
      changes.push({
        kind: nextRequired.has(key) ? "added_required_property" : "added_optional_property",
        path: `${path}/properties/${key}`,
      });
    }
  }

  for (const branch of ["items", "$defs", "definitions"] as const) {
    const baseBranch = base[branch];
    const nextBranch = next[branch];
    if (isNode(baseBranch) && isNode(nextBranch)) {
      if (branch === "items") {
        changes.push(...diffJsonSchema(baseBranch, nextBranch, `${path}/items`));
      } else {
        for (const key of Object.keys(baseBranch)) {
          if (key in nextBranch) {
            changes.push(...diffJsonSchema(baseBranch[key], nextBranch[key], `${path}/${branch}/${key}`));
          } else {
            changes.push({ kind: "removed_property", path: `${path}/${branch}/${key}` });
          }
        }
      }
    }
  }

  return changes;
}

export interface VersionBumpVerdict {
  ok: boolean;
  requires: "none" | "minor" | "major";
  breaking: SchemaChange[];
  additive: SchemaChange[];
  reason?: string;
}

const parseSemver = (version: string): [number, number, number] => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`schema version must be semver, got ${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

/** Gate a schema change against the declared version delta (TRD §15.2). */
export function checkVersionBump(
  baseVersion: string,
  nextVersion: string,
  changes: readonly SchemaChange[],
): VersionBumpVerdict {
  const breaking = changes.filter((c) => BREAKING.has(c.kind));
  const additive = changes.filter((c) => !BREAKING.has(c.kind));
  const [bMaj, bMin] = parseSemver(baseVersion);
  const [nMaj, nMin] = parseSemver(nextVersion);
  const requires: VersionBumpVerdict["requires"] =
    breaking.length > 0 ? "major" : additive.length > 0 ? "minor" : "none";

  if (requires === "major" && nMaj <= bMaj) {
    return { ok: false, requires, breaking, additive, reason: `breaking change requires a major bump (${baseVersion} → ${nextVersion})` };
  }
  if (requires === "minor" && nMaj === bMaj && nMin <= bMin) {
    return { ok: false, requires, breaking, additive, reason: `additive change (incl. enum additions) requires at least a minor bump (${baseVersion} → ${nextVersion})` };
  }
  return { ok: true, requires, breaking, additive };
}

// --- reader support window (TRD §9.3) ------------------------------------

export const CURRENT_SCHEMA_MAJOR = parseSemver(SCHEMA_VERSION)[0];

/** Readers support the current major and exactly one prior during rollout. */
export function readerSupportsMajor(major: number): boolean {
  return Number.isInteger(major) && (major === CURRENT_SCHEMA_MAJOR || major === CURRENT_SCHEMA_MAJOR - 1) && major >= 1;
}

// --- migration contract ----------------------------------------------------

export interface MigratedSnapshot<T> {
  /** A NEW object; the stored historical blob is never mutated in place. */
  snapshot: T;
  /** Provenance: which schema version the source blob carried. */
  sourceSchemaVersion: string;
  migrated: boolean;
}

/**
 * Migrate a stored snapshot blob to the current major. Never mutates the
 * input; records source provenance. With only major 1 in existence this is
 * the (deep-copied) identity migration. The first real major bump must add
 * its transform here, and the baseline gate makes that impossible to forget.
 */
export function migrateToCurrentMajor<T extends { schemaVersion: string }>(blob: T): MigratedSnapshot<T> {
  const sourceMajor = parseSemver(blob.schemaVersion)[0];
  if (!readerSupportsMajor(sourceMajor)) {
    throw new Error(
      `schema major ${sourceMajor} is outside the supported window (current ${CURRENT_SCHEMA_MAJOR} + one prior)`,
    );
  }
  const copy = structuredClone(blob);
  if (sourceMajor === CURRENT_SCHEMA_MAJOR) {
    return { snapshot: copy, sourceSchemaVersion: blob.schemaVersion, migrated: false };
  }
  // Prior-major transform slot: unreachable until a major > 1 exists.
  return { snapshot: copy, sourceSchemaVersion: blob.schemaVersion, migrated: true };
}
