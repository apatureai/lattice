import { UIGraphError } from "./api.js";
import type { UiGraphViewKind } from "./capability-descriptor.js";

/**
 * Consumer view-consumption contract + R2 shadow-build seam (ui-graph#26; PRD §4
 * consumers, §9 R2, ARCHITECTURE §4/§15/§16, TRD §6/§10/§16).
 *
 * The backlog builds snapshots, views, lineage, deltas, and the benchmark, but
 * nothing defined HOW a consumer safely depends on them behind the flag. This
 * closes the loop from "we can build a graph" to "a consumer can depend on it":
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

function scopeOf(elementRef: string): string | null {
  const m = ELEMENT_REF.exec(elementRef);
  return m ? m[1]! : null;
}

/** The 8-hex ref-scope prefix a snapshot's `refScopeDigest` produces. */
export function snapshotRefScope(refScopeDigest: string): string {
  const m = /^sha256:([0-9a-f]{8})[0-9a-f]{56}$/.exec(refScopeDigest);
  if (!m) throw new UIGraphError("invalid_snapshot", "refScopeDigest must be a sha256 digest");
  return m[1]!;
}

export type RefResolution =
  | { ok: true; elementRef: string }
  | { ok: false; reason: "stale_or_foreign_ref"; recovery: "requery_lineage_match" };

/**
 * Resolve an `elementRef` against the current snapshot's ref scope. A ref minted
 * under a different snapshot (or malformed) is `stale_or_foreign_ref` with the
 * requery/lineage-match recovery path — never silently treated as valid.
 */
export function resolveSnapshotLocalRef(elementRef: string, refScopeDigest: string): RefResolution {
  const scope = scopeOf(elementRef);
  if (scope !== null && scope === snapshotRefScope(refScopeDigest)) return { ok: true, elementRef };
  return { ok: false, reason: "stale_or_foreign_ref", recovery: "requery_lineage_match" };
}

/** Assert an `elementRef` is snapshot-local, throwing a typed `stale_or_foreign_ref` otherwise. */
export function assertSnapshotLocalRef(elementRef: string, refScopeDigest: string): string {
  const r = resolveSnapshotLocalRef(elementRef, refScopeDigest);
  if (!r.ok) throw new UIGraphError("stale_or_foreign_ref", `elementRef ${elementRef} is not local to this snapshot`);
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
