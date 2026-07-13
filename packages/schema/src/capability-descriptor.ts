import { canonicalize, sha256 } from "./canonical.js";
import { SUPPORTED_CAPTURE_MAJORS, SUPPORTED_DNA_PROJECTION_MAJORS } from "./readprofile.js";
import { SCHEMA_VERSION, type UIGraphViewSpec } from "./types.js";

/**
 * UI Graph capability descriptor (#25; core #105 / INTEROP.md §2).
 *
 * UI Graph is NOT a network surface — it is a deterministic representation
 * library inside Judgment Engine (ARCHITECTURE ADR-002). So it does NOT publish
 * a signed `ApatureAgentCardV1` (signing, the static registry, OAuth2.1
 * token-exchange identity/tenancy, and OTel tracing all live in core/JE per core
 * #105 decisions 2–6). What UI Graph OWNS is the truthful, machine-readable
 * description of the representation capabilities it offers, so Judgment Engine
 * can fold them into the card IT signs and publishes — and consumers can
 * negotiate versions without reading prose.
 *
 * The descriptor advertises a PERCEPTION/REPRESENTATION capability only: no
 * model calls, browser actions, capture, or delivery (PRD §12, README). In
 * particular `actionMap` is a perception VIEW, never an action affordance (TRD
 * §10.2, #16) — `capabilityClass` stays `representation` and `excludes` names
 * action execution explicitly, consistent with the ownership matrix
 * (ARCHITECTURE §16).
 */

export const UI_GRAPH_CAPABILITY_DESCRIPTOR_VERSION = "ui-graph-capability/1" as const;

/** The operations UI Graph offers (TRD §1) — the actual exported API surface. */
export type UiGraphOperation = "buildUiGraph" | "queryUiGraph" | "diffUiGraphs" | "applyUiGraphDelta";

/** The view kinds UI Graph renders (TRD §10) — reuses the view-spec vocabulary, no parallel enum. */
export type UiGraphViewKind = UIGraphViewSpec["kind"];

/** Supported schema majors + one-prior compatibility (TRD §9.3). */
export interface SchemaMajorSupport {
  supported: readonly string[];
  /** One-prior majors still accepted for compatibility; empty when there is no prior. */
  onePrior: readonly string[];
}

export interface UiGraphCapabilityDescriptor {
  descriptorVersion: typeof UI_GRAPH_CAPABILITY_DESCRIPTOR_VERSION;
  surface: "ui-graph";
  /** How the capability is reached: a library folded into Judgment Engine, not a network listener. */
  exposure: "library_in_judgment_engine";
  /** Perception/representation only — never action/browser/model/capture/delivery. */
  capabilityClass: "representation";
  operations: readonly UiGraphOperation[];
  viewKinds: readonly UiGraphViewKind[];
  /** `actionMap` is a perception view, NOT an action affordance (TRD §10.2, #16). */
  actionMapIsPerceptionOnly: true;
  /** Schema majors UI Graph PRODUCES. */
  produced: { snapshot: SchemaMajorSupport; view: SchemaMajorSupport; delta: SchemaMajorSupport };
  /** Read-profile schema majors UI Graph CONSUMES (TRD §4). */
  consumed: { captureBundle: SchemaMajorSupport; dnaProjection: SchemaMajorSupport };
  /** Capabilities UI Graph explicitly does NOT offer (ownership matrix, ARCHITECTURE §16). */
  excludes: readonly string[];
  /** Version-negotiation policy a caller needs to compose a truthful card (#18). */
  negotiation: {
    /** Namespace prefix required on any non-standard extension field. */
    extensionsNamespacePrefix: string;
    /** What a consumer does with an unrecognized enum member. */
    unknownEnumPolicy: "reject";
  };
}

/** The major component of a version ("1.0.0" → "1"). */
export function majorOf(version: string): string {
  return version.split(".")[0] ?? version;
}

/** Capabilities UI Graph never offers — the boundary the descriptor must always assert. */
export const EXCLUDED_CAPABILITIES: readonly string[] = Object.freeze([
  "model_calls",
  "browser_actions",
  "capture",
  "delivery",
  "action_execution",
]);

const OPERATIONS: readonly UiGraphOperation[] = Object.freeze([
  "buildUiGraph",
  "queryUiGraph",
  "diffUiGraphs",
  "applyUiGraphDelta",
]);

const VIEW_KINDS: readonly UiGraphViewKind[] = Object.freeze([
  "summary",
  "violations",
  "focus",
  "actionMap",
  "patchContext",
  "diff",
]);

function produced(): SchemaMajorSupport {
  // Snapshot, view, and delta all stamp SCHEMA_VERSION; only major 1 exists, so no prior.
  return { supported: [majorOf(SCHEMA_VERSION)], onePrior: [] };
}

/**
 * Build UI Graph's truthful capability descriptor. Every field is derived from
 * the real contract constants (`SCHEMA_VERSION`, `SUPPORTED_CAPTURE_MAJORS`,
 * `SUPPORTED_DNA_PROJECTION_MAJORS`), so it can never advertise a capability or
 * schema major the library does not actually speak.
 */
export function buildUiGraphCapabilityDescriptor(): UiGraphCapabilityDescriptor {
  return {
    descriptorVersion: UI_GRAPH_CAPABILITY_DESCRIPTOR_VERSION,
    surface: "ui-graph",
    exposure: "library_in_judgment_engine",
    capabilityClass: "representation",
    operations: OPERATIONS,
    viewKinds: VIEW_KINDS,
    actionMapIsPerceptionOnly: true,
    produced: { snapshot: produced(), view: produced(), delta: produced() },
    consumed: {
      captureBundle: { supported: [...SUPPORTED_CAPTURE_MAJORS], onePrior: [] },
      dnaProjection: { supported: [...SUPPORTED_DNA_PROJECTION_MAJORS], onePrior: [] },
    },
    excludes: EXCLUDED_CAPABILITIES,
    negotiation: { extensionsNamespacePrefix: "x-uigraph-", unknownEnumPolicy: "reject" },
  };
}

export interface DescriptorValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a descriptor against its own rules: it must advertise representation
 * only, exclude every action/model/browser/capture/delivery capability, keep
 * `actionMap` perception-only, and enumerate non-empty known operations/views.
 * This is the schema UI Graph's descriptor validates against (acceptance #1/#2).
 */
export function validateCapabilityDescriptor(d: UiGraphCapabilityDescriptor): DescriptorValidation {
  const errors: string[] = [];
  if (d.capabilityClass !== "representation") errors.push("capabilityClass must be 'representation'");
  if (d.exposure !== "library_in_judgment_engine") errors.push("UI Graph is a library, not a network surface");
  if (d.actionMapIsPerceptionOnly !== true) errors.push("actionMap must be declared perception-only");
  for (const cap of EXCLUDED_CAPABILITIES) {
    if (!d.excludes.includes(cap)) errors.push(`excludes must name '${cap}' (ownership matrix)`);
  }
  if (d.operations.length === 0) errors.push("operations must be non-empty");
  if (d.viewKinds.length === 0) errors.push("viewKinds must be non-empty");
  const knownOps = new Set(OPERATIONS);
  for (const op of d.operations) if (!knownOps.has(op)) errors.push(`unknown operation '${op}'`);
  const knownViews = new Set<string>(VIEW_KINDS);
  for (const v of d.viewKinds) if (!knownViews.has(v)) errors.push(`unknown view kind '${v}'`);
  return { valid: errors.length === 0, errors };
}

export class NonRepresentationCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRepresentationCapabilityError";
  }
}

/** Fail closed if a descriptor is not representation-only (e.g. a future edit adds an action capability). */
export function assertRepresentationOnly(d: UiGraphCapabilityDescriptor): UiGraphCapabilityDescriptor {
  const { valid, errors } = validateCapabilityDescriptor(d);
  if (!valid) throw new NonRepresentationCapabilityError(errors.join("; "));
  return d;
}

/** Canonical serialization (reusing the repo's RFC 8785 canonicalizer) so JE can fold + pin the descriptor. */
export function serializeCapabilityDescriptor(d: UiGraphCapabilityDescriptor): string {
  return canonicalize(d);
}

/** Content digest of the descriptor — what a consumer/registry pins. `sha256()` already prefixes "sha256:". */
export function computeCapabilityDescriptorDigest(d: UiGraphCapabilityDescriptor): string {
  return sha256(serializeCapabilityDescriptor(d));
}
