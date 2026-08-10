/**
 * UI-DNA token/scale projection matcher (#11; TRD §5.7, §8.7, ARCHITECTURE
 * ADR-006).
 *
 * Projects a SUPPLIED, approved UI-DNA read profile onto graph nodes without
 * taking ownership of UI DNA: extraction/approval/canonical storage stay in
 * `apatureai/canon`; this slice only CONSUMES the approved projection. It emits
 * `UIDNAMatch` facts for the token surface (colors) and numeric scales (spacing,
 * radii, type): exact normalized equality → numeric tolerance → approved
 * exceptions before drift. Component/structural and embedding matching are a
 * follow-on (they need the projection's `componentFamilies`, which canon types).
 *
 * Load-bearing invariants (TRD §4.3, §8.7, §16):
 *   - Only deterministic matches against APPROVED DNA in a PRODUCTION build may
 *     be `authoritative: true`; every experimental/shadow match is advisory.
 *   - Missing DNA ⇒ a neutral graph: no matches, no drift claims (never guessed).
 *   - Non-approved DNA in a production build is REJECTED (via `validateDnaProfile`).
 * UI Graph never mutates, approves, or extends UI DNA (PRD §12).
 */

import { validateDnaProfile, dnaMatchesMayBeAuthoritative, type AdapterIssue } from "../adapter.js";
import type { AnyUIDNAReadProfile, UIDNAToken } from "../readprofile.js";
import type { EvidenceClaim, UIDNAMatch, UIDNAProjection, UIGraphNode, UIGraphUseMode } from "../types.js";
import { normalizeColor } from "./color.js";
import { normalizeCssLength } from "./css.js";

/** Matcher version. A rule/tolerance change forks a new series. */
export const DNA_MATCH_VERSION = "dna-match@1";

/** Per-kind tolerance: colors match exactly; numeric scales admit a small band. */
export interface DnaMatchTolerances {
  /** Absolute CSS-pixel tolerance for a numeric scale match. */
  readonly numericAbsPx: number;
  /** Relative tolerance (fraction of the canonical value) for a numeric scale match. */
  readonly numericRelative: number;
}

export const DEFAULT_TOLERANCES: DnaMatchTolerances = { numericAbsPx: 0.5, numericRelative: 0.02 };

/**
 * A typed approved-exception rule the matcher consumes. (ui-dna owns the
 * canonical exception schema; this is the read-profile projection UI Graph
 * reads.) An exception matching an element's route/category turns a would-be
 * drift into `excepted`, never a silent pass.
 */
export interface DnaExceptionRule {
  readonly route?: string;
  readonly category?: UIDNAMatch["category"];
  readonly elementRef?: string;
  readonly reason: string;
}

export interface DnaProjectionInput {
  /** The supplied read profile. `undefined` ⇒ neutral (no DNA, no matches). */
  readonly dna?: AnyUIDNAReadProfile;
  readonly useMode: UIGraphUseMode;
  /** The element route (from UIGraphSourceMetadata). Exceptions are route-scoped. */
  readonly route: string;
  readonly exceptions?: readonly DnaExceptionRule[];
  readonly tolerances?: Partial<DnaMatchTolerances>;
}

export type DnaProjectionResult =
  | { ok: true; nodes: UIGraphNode[]; projection?: UIDNAProjection }
  | { ok: false; issues: AdapterIssue[] };

// --- style → token-category observations --------------------------------------

interface StyleObservation {
  readonly property: string;
  readonly value: string | number;
  /** DNA match category this observation is judged under. */
  readonly matchCategory: "token" | "scale";
  /** DNA token category to compare against. */
  readonly tokenCategory: string;
  readonly kind: "color" | "numeric";
}

/** Extract the observed style facts that map to an approved-DNA token category. */
function observationsOf(style: UIGraphNode["style"]): StyleObservation[] {
  const out: StyleObservation[] = [];
  const color = (property: string, value: string | undefined): void => {
    if (value !== undefined) out.push({ property, value, matchCategory: "token", tokenCategory: "color", kind: "color" });
  };
  const numeric = (property: string, tokenCategory: string, value: number | undefined): void => {
    if (value !== undefined) out.push({ property, value, matchCategory: "scale", tokenCategory, kind: "numeric" });
  };
  color("color", style.color);
  color("backgroundColor", style.backgroundColor);
  numeric("fontSizeCssPx", "typography", style.fontSizeCssPx);
  numeric("lineHeightCssPx", "typography", style.lineHeightCssPx);
  for (const r of style.borderRadiusCssPx ?? []) numeric("borderRadiusCssPx", "radii", r);
  for (const [key, value] of Object.entries(style.spacing ?? {})) {
    out.push({ property: `spacing.${key}`, value, matchCategory: "scale", tokenCategory: "spacing", kind: "numeric" });
  }
  return out;
}

// --- matching -----------------------------------------------------------------

interface MatchContext {
  readonly tokens: Record<string, UIDNAToken>;
  readonly route: string;
  readonly exceptions: readonly DnaExceptionRule[];
  readonly tolerances: DnaMatchTolerances;
  readonly mayBeAuthoritative: boolean;
}

interface TokenCandidate {
  readonly dnaRef: string;
  readonly token: UIDNAToken;
}

function tokensInCategory(tokens: Record<string, UIDNAToken>, category: string): TokenCandidate[] {
  return Object.entries(tokens)
    .filter(([, token]) => token.category === category)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([dnaRef, token]) => ({ dnaRef, token }));
}

/** Nearest numeric token by absolute delta; null when the category has no numeric tokens. */
function nearestNumeric(observedPx: number, candidates: TokenCandidate[]): { candidate: TokenCandidate; delta: number } | null {
  let best: { candidate: TokenCandidate; delta: number } | null = null;
  for (const candidate of candidates) {
    const canonical = normalizeCssLength(candidate.token.value).valueCssPx;
    if (canonical === null) continue;
    const delta = Math.abs(observedPx - canonical);
    if (best === null || delta < best.delta) best = { candidate, delta };
  }
  return best;
}

function exceptionApplies(ctx: MatchContext, node: UIGraphNode, category: UIDNAMatch["category"]): DnaExceptionRule | undefined {
  return ctx.exceptions.find(
    (e) =>
      (e.route === undefined || e.route === ctx.route) &&
      (e.category === undefined || e.category === category) &&
      (e.elementRef === undefined || e.elementRef === node.elementRef),
  );
}

function matchObservation(obs: StyleObservation, node: UIGraphNode, ctx: MatchContext): UIDNAMatch | null {
  const candidates = tokensInCategory(ctx.tokens, obs.tokenCategory);
  if (candidates.length === 0) return null; // no approved tokens in this category ⇒ nothing to judge against
  const evidence: EvidenceClaim[] = [{ sourceType: "ui_dna", confidence: 1, claims: [`style:${obs.property}`] }];

  if (obs.kind === "color") {
    const observed = normalizeColor(String(obs.value)).canonical;
    if (observed === null) return null; // unparseable observed color ⇒ abstain, never guess
    const hit = candidates.find((candidate) => normalizeColor(String(candidate.token.value)).canonical === observed);
    if (hit) {
      return finalize(node, ctx, {
        dnaRef: hit.dnaRef,
        category: "token", status: "exact", method: "exact_value",
        observed: obs.value, canonical: hit.token.value, confidence: hit.token.confidence, evidence,
      });
    }
    return withDriftOrException(node, ctx, "token", {
      dnaRef: `category:${obs.tokenCategory}`,
      observed: obs.value,
      method: "exact_value",
      evidence,
    });
  }

  // numeric scale
  const observedPx = normalizeCssLength(obs.value).valueCssPx;
  if (observedPx === null) return null;
  const nearest = nearestNumeric(observedPx, candidates);
  if (nearest === null) return null;
  const band = Math.max(ctx.tolerances.numericAbsPx, ctx.tolerances.numericRelative * observedPx);
  if (nearest.delta === 0) {
    return finalize(node, ctx, {
      dnaRef: nearest.candidate.dnaRef,
      category: "scale", status: "exact", method: "numeric_tolerance",
      observed: obs.value, canonical: nearest.candidate.token.value, delta: 0, confidence: nearest.candidate.token.confidence, evidence,
    });
  }
  if (nearest.delta <= band) {
    return finalize(node, ctx, {
      dnaRef: nearest.candidate.dnaRef,
      category: "scale", status: "within_tolerance", method: "numeric_tolerance",
      observed: obs.value, canonical: nearest.candidate.token.value, delta: nearest.delta, confidence: nearest.candidate.token.confidence, evidence,
    });
  }
  return withDriftOrException(node, ctx, "scale", {
    dnaRef: nearest.candidate.dnaRef,
    observed: obs.value,
    canonical: nearest.candidate.token.value,
    delta: nearest.delta,
    method: "numeric_tolerance",
    evidence,
  });
}

function withDriftOrException(
  node: UIGraphNode,
  ctx: MatchContext,
  category: UIDNAMatch["category"],
  parts: { dnaRef: string; observed: string | number; canonical?: string | number; delta?: number; method: UIDNAMatch["method"]; evidence: EvidenceClaim[] },
): UIDNAMatch {
  const exception = exceptionApplies(ctx, node, category);
  if (exception) {
    return finalize(node, ctx, {
      dnaRef: parts.dnaRef,
      category, status: "excepted", method: "rule_evaluation",
      observed: parts.observed, canonical: parts.canonical, delta: parts.delta, confidence: node.confidence,
      evidence: [...parts.evidence, { sourceType: "ui_dna", confidence: 1, claims: [`exception:${exception.reason}`] }],
    });
  }
  return finalize(node, ctx, {
    dnaRef: parts.dnaRef,
    category, status: "drift", method: parts.method,
    observed: parts.observed, canonical: parts.canonical, delta: parts.delta, confidence: node.confidence, evidence: parts.evidence,
  });
}

const DETERMINISTIC_METHODS: ReadonlySet<UIDNAMatch["method"]> = new Set([
  "exact_value",
  "numeric_tolerance",
  "declared_component",
  "structural_signature",
  "rule_evaluation",
]);

function finalize(
  node: UIGraphNode,
  ctx: MatchContext,
  m: Omit<UIDNAMatch, "authoritative">,
): UIDNAMatch {
  // Authoritative only for a deterministic method against approved+production DNA;
  // a `drift` is a finding, not an authoritative canonical assignment.
  const authoritative =
    ctx.mayBeAuthoritative && DETERMINISTIC_METHODS.has(m.method) && m.status !== "drift" && m.status !== "unknown";
  return { authoritative, ...m };
}

/** Match one node's style facts against the approved tokens (pure). */
function matchNodeTokens(node: UIGraphNode, ctx: MatchContext): UIDNAMatch[] {
  return observationsOf(node.style)
    .map((obs) => matchObservation(obs, node, ctx))
    .filter((m): m is UIDNAMatch => m !== null);
}

/**
 * Project an approved DNA read profile onto graph nodes. Validates the profile
 * against the build use mode (rejecting non-approved DNA in production), matches
 * every node's token/scale facts, and returns nodes with `dnaMatches` populated
 * plus the projection summary. Missing DNA is neutral: nodes come back untouched
 * with no matches and no projection.
 */
export function projectDna(nodes: readonly UIGraphNode[], input: DnaProjectionInput): DnaProjectionResult {
  if (input.dna === undefined) {
    return { ok: true, nodes: nodes.map((n) => ({ ...n, dnaMatches: [] })) };
  }
  const validation = validateDnaProfile(input.dna, input.useMode);
  if (!validation.ok) return { ok: false, issues: validation.issues };

  const ctx: MatchContext = {
    tokens: input.dna.tokens,
    route: input.route,
    exceptions: input.exceptions ?? [],
    tolerances: { ...DEFAULT_TOLERANCES, ...input.tolerances },
    mayBeAuthoritative: dnaMatchesMayBeAuthoritative(input.dna, input.useMode),
  };

  let authoritativeMatchCount = 0;
  let advisoryMatchCount = 0;
  let driftCount = 0;
  const matchedNodes = nodes.map((node) => {
    const dnaMatches = matchNodeTokens(node, ctx);
    for (const m of dnaMatches) {
      if (m.status === "drift") driftCount++;
      if (m.authoritative) authoritativeMatchCount++;
      else advisoryMatchCount++;
    }
    return { ...node, dnaMatches };
  });

  const projection: UIDNAProjection = {
    dnaVersion: input.dna.dnaVersion,
    projectionSchemaVersion: input.dna.projectionSchemaVersion,
    dnaContentDigest: input.dna.dnaContentDigest,
    state: input.dna.state,
    useMode: input.useMode,
    authoritativeMatchCount,
    advisoryMatchCount,
    driftCount,
  };
  return { ok: true, nodes: matchedNodes, projection };
}
