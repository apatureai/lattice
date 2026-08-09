import { UIGraphError } from "./api.js";
import { assertSnapshotIdentity } from "./canonical.js";
import type { UiGraphViewKind } from "./capability-descriptor.js";
import type { UIGraphSnapshot } from "./types.js";

/**
 * Consumer view-consumption contract + R2 shadow-build seam (ui-graph#26; PRD §4
 * consumers, §9 R2, ARCHITECTURE §4/§15/§16, TRD §6/§10/§16).
 *
 * The rest of the package builds snapshots, views, lineage, deltas, and the
 * benchmark; this module defines HOW a consumer safely depends on them while
 * the representation is still behind a feature flag. It covers:
 *  - which view kind each product surface may request, and what it must NOT
 *    depend on (ownership matrix);
 *  - the R2 shadow contract: views are built + stored in parallel but NEVER
 *    enter a published finding, with a graph-backed vs current-prompt comparison
 *    hook on identical captures;
 *  - the honest-reference seam: an `elementRef` is snapshot-local and rejected
 *    with a typed `stale_or_foreign_ref` across snapshots; a consumer never
 *    treats a ref as a selector or browser handle;
 *  - typed failure + recovery for stale refs and corrupt deltas.
 *
 * Contract-only: orchestration, storage, and inference stay in Judgment Engine.
 */

export const CONSUMER_CONTRACT_VERSION = "ui-graph-consumer/1" as const;

/** The product surfaces that consume UI Graph through Judgment Engine (PRD §4). */
export type ConsumerSurface = "gate" | "mcp_review" | "pointer" | "interactive_review";

export interface ConsumerViewContract {
  surface: ConsumerSurface;
  /** The view kinds this consumer may request (TRD §10). */
  requestsViewKinds: readonly UiGraphViewKind[];
  /** interactive_review's `actionMap` is read-only PERCEPTION, never an action affordance. */
  readOnlyPerception: boolean;
  /** What the consumer must NOT depend on (ownership matrix, ARCHITECTURE §16, PRD §10/§12). */
  mustNotDependOn: readonly string[];
}

const COMMON_FORBIDDEN: readonly string[] = Object.freeze([
  "ui_graph_internals",
  "another_tenants_graph",
  "element_ref_as_selector",
  "element_ref_as_browser_handle",
]);

export const CONSUMER_VIEW_CONTRACT: Readonly<Record<ConsumerSurface, ConsumerViewContract>> = Object.freeze({
  gate: {
    surface: "gate",
    requestsViewKinds: ["violations", "patchContext", "focus"],
    readOnlyPerception: false,
    mustNotDependOn: COMMON_FORBIDDEN,
  },
  mcp_review: {
    surface: "mcp_review",
    requestsViewKinds: ["violations", "patchContext", "focus"],
    readOnlyPerception: false,
    mustNotDependOn: COMMON_FORBIDDEN,
  },
  pointer: {
    surface: "pointer",
    requestsViewKinds: ["focus", "diff"],
    readOnlyPerception: false,
    mustNotDependOn: COMMON_FORBIDDEN,
  },
  interactive_review: {
    surface: "interactive_review",
    requestsViewKinds: ["actionMap"],
    // actionMap is perception only — the consumer reads it, it is never an action affordance.
    readOnlyPerception: true,
    mustNotDependOn: [...COMMON_FORBIDDEN, "action_map_as_action_affordance"],
  },
});

export function consumerContractFor(surface: ConsumerSurface): ConsumerViewContract {
  return CONSUMER_VIEW_CONTRACT[surface];
}

/** Whether a surface is permitted to request a given view kind (its documented contract). */
export function mayRequestView(surface: ConsumerSurface, kind: UiGraphViewKind): boolean {
  return CONSUMER_VIEW_CONTRACT[surface].requestsViewKinds.includes(kind);
}

// --- R2 shadow-build contract (PRD §9 R2) -------------------------------------

/**
 * A shadow run: UI Graph snapshots/views are built + stored in parallel with the
 * current pipeline, but their output NEVER enters a published finding. The flag
 * is a literal `false` so a shadow run is structurally incapable of publishing.
 */
export interface ShadowRun {
  captureId: string;
  usedForPublishedFinding: false;
  /** Hash of the graph-backed prompt built for comparison. */
  graphBackedPromptHash: string;
  /** Hash of the current (non-graph) prompt on the SAME capture. */
  currentPromptHash: string;
}

export class ShadowPublishError extends Error {
  constructor() {
    super("a shadow-mode UI Graph result must never enter a published finding (PRD §9 R2)");
    this.name = "ShadowPublishError";
  }
}

/** Fail closed if a shadow run was (mis)marked as used for a published finding. */
export function assertShadowNeverPublishes(run: ShadowRun): ShadowRun {
  if ((run.usedForPublishedFinding as boolean) !== false) throw new ShadowPublishError();
  return run;
}

export interface ShadowComparison {
  captureId: string;
  graphBackedPromptHash: string;
  currentPromptHash: string;
  /** The R2 signal: did the graph-backed prompt differ from the current prompt on this capture? */
  differs: boolean;
}

/** The R2 comparison hook: compare graph-backed vs current prompt on one identical capture. */
export function compareShadow(run: ShadowRun): ShadowComparison {
  return {
    captureId: run.captureId,
    graphBackedPromptHash: run.graphBackedPromptHash,
    currentPromptHash: run.currentPromptHash,
    differs: run.graphBackedPromptHash !== run.currentPromptHash,
  };
}

// --- honest-reference seam (TRD §6/§16) ---------------------------------------

const ELEMENT_REF = /^ug:([0-9a-f]{8}):(\d+)$/;

/** Whether a value is a well-formed UI Graph `elementRef` (`ug:<8hex>:<ordinal>`). */
export function isElementRef(value: unknown): value is string {
  return typeof value === "string" && ELEMENT_REF.test(value);
}

/** The 8-hex ref-scope prefix a snapshot's `refScopeDigest` produces. */
export function snapshotRefScope(refScopeDigest: string): string {
  const m = /^sha256:([0-9a-f]{8})[0-9a-f]{56}$/.exec(refScopeDigest);
  if (!m) throw new UIGraphError("invalid_snapshot", "refScopeDigest must be a sha256 digest");
  return m[1]!;
}

/** Why a ref was refused. Consumers map every detail fail-closed (#56). */
export type RefRejectDetail =
  | "malformed_ref"
  | "snapshot_identity_invalid"
  | "wrong_snapshot_identity"
  | "ref_not_in_snapshot";

export type RefResolution =
  | { ok: true; elementRef: string }
  | {
      ok: false;
      reason: "stale_or_foreign_ref";
      detail: RefRejectDetail;
      recovery: "requery_lineage_match";
    };

/** The caller's claim about WHICH snapshot its ref belongs to (full tuple, never a prefix). */
export interface ClaimedSnapshotIdentity {
  snapshotId: string;
  contentHash: string;
}

const refuse = (detail: RefRejectDetail): RefResolution => ({
  ok: false,
  reason: "stale_or_foreign_ref",
  detail,
  recovery: "requery_lineage_match",
});

/**
 * Resolve an `elementRef` against a VERIFIED snapshot with EXACT membership
 * (#56; TRD §6/§16). The 8-hex ref-scope prefix is deliberately not authority:
 * this resolver (1) verifies the supplied snapshot's own identity (refs, hash,
 * id self-consistent via `assertSnapshotIdentity`), (2) requires the caller's
 * claimed `(snapshotId, contentHash)` tuple to equal that verified identity
 * exactly — a same-prefix/different-digest snapshot is foreign — and (3)
 * requires the ref to be one of the snapshot's actual node refs, so a
 * fabricated ordinal under the correct prefix names nothing and is refused.
 * Every refusal is a typed `stale_or_foreign_ref` with a fail-closed detail.
 *
 * `ug:*` refs remain immutable evidence only: never a locator hint, selector,
 * browser handle, or a Pointer `ptr:*` ref.
 */
export function resolveElementRefInSnapshot(
  snapshot: UIGraphSnapshot,
  claimed: ClaimedSnapshotIdentity,
  elementRef: string,
): RefResolution {
  if (!isElementRef(elementRef)) return refuse("malformed_ref");
  try {
    assertSnapshotIdentity(snapshot);
  } catch {
    return refuse("snapshot_identity_invalid");
  }
  if (claimed.snapshotId !== snapshot.snapshotId || claimed.contentHash !== snapshot.contentHash) {
    return refuse("wrong_snapshot_identity");
  }
  // Exact membership in the verified snapshot's nodes — never prefix matching.
  if (!snapshot.nodes.some((node) => node.elementRef === elementRef)) {
    return refuse("ref_not_in_snapshot");
  }
  return { ok: true, elementRef };
}

/** Assert exact snapshot membership, throwing a typed `stale_or_foreign_ref` otherwise. */
export function assertElementRefInSnapshot(
  snapshot: UIGraphSnapshot,
  claimed: ClaimedSnapshotIdentity,
  elementRef: string,
): string {
  const r = resolveElementRefInSnapshot(snapshot, claimed, elementRef);
  if (!r.ok) {
    throw new UIGraphError(
      "stale_or_foreign_ref",
      `elementRef ${elementRef} is not a member of the claimed snapshot (${r.detail})`,
    );
  }
  return elementRef;
}

// --- delta-corruption recovery (TRD §16, ARCHITECTURE §10) --------------------

export type DeltaResolution =
  | { ok: true }
  | { ok: false; reason: "invalid_delta" | "delta_base_mismatch"; recovery: "full_checkpoint_fallback" };

/**
 * Resolve a delta apply. A corrupt delta or a base mismatch fails closed with a
 * typed error and the defined recovery: fall back to a full snapshot checkpoint
 * rather than applying a corrupt delta.
 */
export function resolveDelta(check: { valid: boolean; baseMatches: boolean }): DeltaResolution {
  if (!check.baseMatches) return { ok: false, reason: "delta_base_mismatch", recovery: "full_checkpoint_fallback" };
  if (!check.valid) return { ok: false, reason: "invalid_delta", recovery: "full_checkpoint_fallback" };
  return { ok: true };
}
