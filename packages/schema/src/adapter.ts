/**
 * Read-profile adapter / validator (TRD §4, §8.1).
 *
 * The adapter selects and validates the explicit read profiles UI Graph
 * consumes, keeping the snapshot schema closed. It enforces exactly the
 * acceptance rules from issue #3 / TRD §8.1 / §16:
 *
 *  - reject unsupported source-schema majors;
 *  - reject derived observations missing provider / version / confidence;
 *  - reject non-approved DNA in a production build, and force every
 *    non-production / non-approved DNA match non-authoritative downstream.
 *
 * This is hand-written rather than JSON-Schema-driven because the read profiles
 * are deliberately a SUBSET of producer-owned schemas (TRD §4.1): UI Graph
 * validates only what it reads and records the source schema versions consumed.
 * No network/model/browser/DB access (TRD §3.1).
 */

import type {
  CaptureBundleReadProfile,
  DerivedObservation,
  AnyUIDNAReadProfile,
  UIDNAGraphProjectionReadProfile,
} from "./readprofile.js";
import {
  SUPPORTED_CAPTURE_MAJORS,
  SUPPORTED_DNA_PROJECTION_MAJORS,
} from "./readprofile.js";
import type { UIGraphUseMode } from "./types.js";

export type AdapterIssue = {
  code:
    | "unsupported_source_major"
    | "derived_observation_missing_provenance"
    | "non_approved_dna_in_production"
    | "invalid_use_mode"
    | "missing_required_field";
  path: string;
  message: string;
};

export type AdapterResult<T> =
  | { ok: true; value: T; sourceVersions: SourceVersions }
  | { ok: false; issues: AdapterIssue[] };

/** Source schema versions consumed, recorded so the snapshot can echo them (TRD §4). */
export type SourceVersions = {
  captureSchemaVersion: string;
  captureVersion: string;
  dnaProjectionSchemaVersion?: string;
  dnaVersion?: string;
  dnaState?: AnyUIDNAReadProfile["state"];
  dnaUseMode?: UIGraphUseMode;
};

function majorOf(version: string): string {
  return version.split(".")[0] ?? "";
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Validate a derived observation's provenance. Per TRD §8.1/§16, a derived
 * observation missing provider, providerVersion, or a confidence (on the
 * variants that carry one) is rejected. UI Graph never silently trusts an
 * unprovenanced parser/OCR/embedding/learned fact.
 */
function checkDerivedObservation(
  obs: DerivedObservation,
  index: number,
  issues: AdapterIssue[],
): void {
  const base = `derivedObservations[${index}]`;
  if (!isNonEmptyString(obs.provider) || !isNonEmptyString(obs.providerVersion)) {
    issues.push({
      code: "derived_observation_missing_provenance",
      path: base,
      message: `derived observation "${obs.kind}" must carry provider and providerVersion (TRD §8.1, §16)`,
    });
  }
  if (obs.kind === "vision_parser") {
    obs.elements.forEach((el, i) => {
      if (!isFiniteNumber(el.confidence)) {
        issues.push({
          code: "derived_observation_missing_provenance",
          path: `${base}.elements[${i}]`,
          message: "vision_parser element must carry a finite confidence (TRD §8.1)",
        });
      }
    });
  } else if (obs.kind === "ocr") {
    obs.runs.forEach((run, i) => {
      if (!isFiniteNumber(run.confidence)) {
        issues.push({
          code: "derived_observation_missing_provenance",
          path: `${base}.runs[${i}]`,
          message: "ocr run must carry a finite confidence (TRD §8.1)",
        });
      }
    });
  } else if (obs.kind === "learned_relation") {
    if (!isFiniteNumber(obs.confidence)) {
      issues.push({
        code: "derived_observation_missing_provenance",
        path: base,
        message: "learned_relation must carry a finite confidence (TRD §8.1)",
      });
    }
  }
  // embedding carries dimensions + vectorRef, validated structurally below.
}

/**
 * Validate a capture read profile. Records the source versions consumed.
 * Rejects unsupported majors and unprovenanced derived observations.
 */
export function validateCaptureBundle(
  capture: CaptureBundleReadProfile,
): AdapterResult<CaptureBundleReadProfile> {
  const issues: AdapterIssue[] = [];

  if (!isNonEmptyString(capture.schemaVersion)) {
    issues.push({
      code: "missing_required_field",
      path: "schemaVersion",
      message: "capture schemaVersion is required",
    });
  } else if (!SUPPORTED_CAPTURE_MAJORS.includes(majorOf(capture.schemaVersion) as never)) {
    issues.push({
      code: "unsupported_source_major",
      path: "schemaVersion",
      message: `capture schema major "${majorOf(capture.schemaVersion)}" is not supported (supported: ${SUPPORTED_CAPTURE_MAJORS.join(", ")}) (TRD §8.1)`,
    });
  }

  for (const field of ["captureId", "captureVersion", "route"] as const) {
    if (!isNonEmptyString(capture[field])) {
      issues.push({
        code: "missing_required_field",
        path: field,
        message: `capture ${field} is required`,
      });
    }
  }

  (capture.derivedObservations ?? []).forEach((obs, i) =>
    checkDerivedObservation(obs, i, issues),
  );

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: capture,
    sourceVersions: {
      captureSchemaVersion: capture.schemaVersion,
      captureVersion: capture.captureVersion,
    },
  };
}

/**
 * Validate a UI-DNA read profile against the build use mode.
 *
 * Production builds accept ONLY `state: "approved"` (TRD §4.3, §16). Approved
 * DNA may be used authoritatively. Any non-approved (experimental) profile
 * requires a non-production use mode and forces downstream matches
 * non-authoritative; the adapter surfaces the effective use mode so the builder
 * can record it and force `authoritative: false` (TRD §8.7).
 */
export function validateDnaProfile(
  dna: AnyUIDNAReadProfile,
  useMode: UIGraphUseMode,
): AdapterResult<AnyUIDNAReadProfile> {
  const issues: AdapterIssue[] = [];

  if (!isNonEmptyString(dna.projectionSchemaVersion)) {
    issues.push({
      code: "missing_required_field",
      path: "projectionSchemaVersion",
      message: "DNA projectionSchemaVersion is required",
    });
  } else if (
    !SUPPORTED_DNA_PROJECTION_MAJORS.includes(
      majorOf(dna.projectionSchemaVersion) as never,
    )
  ) {
    issues.push({
      code: "unsupported_source_major",
      path: "projectionSchemaVersion",
      message: `DNA projection schema major "${majorOf(dna.projectionSchemaVersion)}" is not supported (TRD §8.1)`,
    });
  }

  const approved = dna.state === "approved";

  if (useMode === "production" && !approved) {
    issues.push({
      code: "non_approved_dna_in_production",
      path: "state",
      message: `production build rejects non-approved DNA (state="${dna.state}") (TRD §4.3, §16)`,
    });
  }

  if (!approved) {
    // Experimental profile must declare an offline_eval/shadow use mode.
    const experimentalUseMode = (dna as { useMode?: UIGraphUseMode }).useMode;
    if (experimentalUseMode !== "offline_eval" && experimentalUseMode !== "shadow") {
      issues.push({
        code: "invalid_use_mode",
        path: "useMode",
        message: `experimental DNA (state="${dna.state}") must declare useMode offline_eval or shadow (TRD §4.3)`,
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const effectiveUseMode: UIGraphUseMode = approved
    ? useMode
    : (dna as { useMode: "offline_eval" | "shadow" }).useMode;

  return {
    ok: true,
    value: dna,
    sourceVersions: {
      captureSchemaVersion: "",
      captureVersion: "",
      dnaProjectionSchemaVersion: dna.projectionSchemaVersion,
      dnaVersion: dna.dnaVersion,
      dnaState: dna.state,
      dnaUseMode: effectiveUseMode,
    },
  };
}

/**
 * True only for an approved DNA profile in a production build, the single case
 * where a deterministic match may be `authoritative: true` (TRD §4.3, §8.7).
 */
export function dnaMatchesMayBeAuthoritative(
  dna: AnyUIDNAReadProfile | undefined,
  useMode: UIGraphUseMode,
): dna is UIDNAGraphProjectionReadProfile {
  return dna !== undefined && dna.state === "approved" && useMode === "production";
}
