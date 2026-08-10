/**
 * Frozen representation fixture manifests (issue #19; PRD §8.1, TRD §15,
 * ARCHITECTURE §16.1).
 *
 * UI Graph owns the representation manifests + labels; the consuming critique
 * pipeline RUNS the evaluation (PRD §5.2, §8). This module defines the manifest
 * FORMAT and the frozen, content-addressed manifest DATA for the six internal
 * eval sets, plus the freeze/verify helpers the benchmark (#20) and promotion
 * gate (#24) build on. It never runs the wider eval and never calls a model,
 * browser, or network; it is pure metadata over MOCK captures.
 *
 * Freezing model: each fixture entry is content-addressed by the RFC 8785 hash
 * of its own semantic body (its `contentHash` field is excluded from that hash,
 * exactly as a snapshot excludes its own `contentHash`). The manifest as a whole
 * is content-addressed by the hash of its ordered, canonicalized entries. A
 * drifting fixture changes its entry hash, which changes the manifest hash, so
 * the eval can pin the exact representation it measured against.
 */

import { canonicalize, sha256 } from "../canonical.js";
import type { Viewport } from "../types.js";

// --- Frozen sets (PRD §8.1) ---------------------------------------------

/** The six internal frozen sets. External diagnostic sets (PRD §8.2) are separate. */
export type FixtureSetId =
  | "ug-core"
  | "ug-lineage"
  | "ug-nondom"
  | "ug-dna"
  | "ug-security"
  | "ug-delta";

export const FIXTURE_SET_IDS: readonly FixtureSetId[] = [
  "ug-core",
  "ug-lineage",
  "ug-nondom",
  "ug-dna",
  "ug-security",
  "ug-delta",
] as const;

/**
 * Cohorts the benchmark reports per-set to prevent aggregate-masked regressions
 * (TRD §15.3, PRD §7). Every fixture is tagged with the cohorts it exercises so
 * the promotion gate (#24) can fail on a single-cohort regression.
 */
export type EvalCohort =
  | "clean"
  | "drifted"
  | "responsive"
  | "dense"
  | "long_page"
  | "non_dom"
  | "injection"
  | "pii"
  | "cross_tenant";

// --- Required metadata stamps (PRD §8.1) --------------------------------

/**
 * Every fixture records the provenance needed to reproduce the exact
 * representation the eval measured. All fields are REQUIRED (PRD §8.1): a
 * fixture missing any stamp is not admissible to the frozen set.
 */
export interface FixtureProvenance {
  readonly captureVersion: string;
  readonly browserVersion: string;
  readonly viewport: Viewport;
  readonly graphBuilderVersion: string;
  readonly uiDnaVersion: string;
  readonly redactionPolicyVersion: string;
  /** License + consent status for the source content (PRD §8.1). */
  readonly license: FixtureLicense;
}

export interface FixtureLicense {
  /** SPDX-style identifier or `synthetic` for fabricated fixtures. */
  readonly spdx: string;
  /** Whether consent to use the source content is on record. */
  readonly consent: "synthetic" | "recorded" | "not_required";
  readonly attribution?: string;
}

// --- Fixture entry ------------------------------------------------------

/**
 * A `ug-delta` mutation-sequence step: a labeled mutation and the canonical
 * target snapshot hash the reconstruction test must reproduce (PRD §8.1, TRD
 * §15.2 delta reconstruction).
 */
export interface DeltaSequenceStep {
  readonly label: string;
  readonly mutation:
    | "insert"
    | "remove"
    | "reorder"
    | "text_edit"
    | "component_replace"
    | "responsive";
  /** Canonical target `contentHash` after applying this step (TRD §9.2). */
  readonly canonicalTargetHash: string;
}

export interface FixtureEntry {
  readonly fixtureId: string;
  readonly setId: FixtureSetId;
  readonly title: string;
  readonly cohorts: readonly EvalCohort[];
  readonly provenance: FixtureProvenance;
  /**
   * Relative path (from this package's fixtures root) to the frozen MOCK capture
   * read-profile this fixture references. The bytes are the golden fixtures the
   * adapter tests already freeze (issue #3); the eval harness resolves them.
   */
  readonly captureRef: string;
  /** Present only on `ug-delta` fixtures: the mutation sequence + target hashes. */
  readonly deltaSequence?: readonly DeltaSequenceStep[];
  /**
   * Content hash of this entry's semantic body (everything except `contentHash`).
   * Assigned by `freezeManifest`; verified by `verifyManifest`.
   */
  readonly contentHash: string;
}

export interface FixtureSet {
  readonly setId: FixtureSetId;
  readonly description: string;
  readonly fixtures: readonly FixtureEntry[];
}

export interface RepresentationManifest {
  readonly schemaVersion: string;
  readonly sets: readonly FixtureSet[];
  /**
   * Content hash over the ordered, canonicalized sets (each fixture already
   * carrying its own frozen `contentHash`). This is the id the benchmark and
   * gate pin. Assigned by `freezeManifest`.
   */
  readonly manifestContentHash: string;
}

export const MANIFEST_SCHEMA_VERSION = "1.0.0" as const;

// --- Freeze / verify ----------------------------------------------------

/** Hash a fixture entry's semantic body, excluding its own `contentHash`. */
export function fixtureContentHash(entry: Omit<FixtureEntry, "contentHash">): string {
  return sha256(canonicalize(entry as unknown as Record<string, unknown>));
}

/** Hash the ordered sets (fixtures already sealed) into the manifest id. */
function manifestHash(sets: readonly FixtureSet[]): string {
  return sha256(canonicalize(sets as unknown as unknown[]));
}

/** A set awaiting freeze: fixtures without their (about-to-be-assigned) hashes. */
export interface UnsealedFixtureSet {
  readonly setId: FixtureSetId;
  readonly description: string;
  readonly fixtures: readonly Omit<FixtureEntry, "contentHash">[];
}

/**
 * Seal a manifest: assign each fixture its `contentHash`, then the manifest its
 * `manifestContentHash`. Deterministic for byte-identical semantic input: no
 * wall-clock, randomness, or locale-dependent formatting is read (TRD §9).
 */
export function freezeManifest(sets: readonly UnsealedFixtureSet[]): RepresentationManifest {
  const sealedSets: FixtureSet[] = sets.map((set) => ({
    setId: set.setId,
    description: set.description,
    fixtures: set.fixtures.map((f) => ({ ...f, contentHash: fixtureContentHash(f) })),
  }));
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    sets: sealedSets,
    manifestContentHash: manifestHash(sealedSets),
  };
}

export type ManifestVerification =
  | { ok: true; manifestContentHash: string }
  | { ok: false; errors: string[] };

/**
 * Verify a frozen manifest: every fixture's `contentHash` recomputes, the
 * manifest hash recomputes, the required metadata stamps are all present, every
 * fixture records a license/consent status, and every `ug-delta` fixture carries
 * canonical target hashes. This is the acceptance check for issue #19.
 */
export function verifyManifest(manifest: RepresentationManifest): ManifestVerification {
  const errors: string[] = [];

  for (const set of manifest.sets) {
    for (const entry of set.fixtures) {
      const { contentHash, ...body } = entry;
      const recomputed = fixtureContentHash(body);
      if (recomputed !== contentHash) {
        errors.push(`fixture ${entry.fixtureId} content hash drifted (expected ${contentHash}, got ${recomputed})`);
      }
      errors.push(...provenanceErrors(entry));
      if (set.setId === "ug-delta") {
        errors.push(...deltaErrors(entry));
      }
    }
  }

  const recomputedManifest = manifestHash(manifest.sets);
  if (recomputedManifest !== manifest.manifestContentHash) {
    errors.push(`manifest content hash drifted (expected ${manifest.manifestContentHash}, got ${recomputedManifest})`);
  }

  return errors.length === 0
    ? { ok: true, manifestContentHash: manifest.manifestContentHash }
    : { ok: false, errors };
}

function provenanceErrors(entry: FixtureEntry): string[] {
  const out: string[] = [];
  const p = entry.provenance;
  const required: Array<[string, string]> = [
    ["captureVersion", p.captureVersion],
    ["browserVersion", p.browserVersion],
    ["graphBuilderVersion", p.graphBuilderVersion],
    ["uiDnaVersion", p.uiDnaVersion],
    ["redactionPolicyVersion", p.redactionPolicyVersion],
  ];
  for (const [name, value] of required) {
    if (typeof value !== "string" || value.trim().length === 0) {
      out.push(`fixture ${entry.fixtureId} is missing required stamp "${name}"`);
    }
  }
  if (p.viewport === undefined || p.viewport.widthCssPx <= 0 || p.viewport.heightCssPx <= 0) {
    out.push(`fixture ${entry.fixtureId} is missing a valid viewport stamp`);
  }
  // License + consent status is required for EVERY fixture (PRD §8.1 acceptance).
  if (p.license === undefined || typeof p.license.spdx !== "string" || p.license.spdx.trim().length === 0) {
    out.push(`fixture ${entry.fixtureId} is missing a license status`);
  }
  if (p.license?.consent === undefined) {
    out.push(`fixture ${entry.fixtureId} is missing a consent status`);
  }
  return out;
}

function deltaErrors(entry: FixtureEntry): string[] {
  const out: string[] = [];
  const seq = entry.deltaSequence;
  if (seq === undefined || seq.length === 0) {
    out.push(`ug-delta fixture ${entry.fixtureId} carries no mutation sequence`);
    return out;
  }
  for (const step of seq) {
    if (typeof step.canonicalTargetHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(step.canonicalTargetHash)) {
      out.push(`ug-delta fixture ${entry.fixtureId} step "${step.label}" lacks a canonical target hash`);
    }
  }
  return out;
}
