/**
 * Offline representation benchmark runner (issue #20; TRD §15.1, PRD §9 R1).
 *
 * This module mechanizes the R1 protocol: for every fixture in the frozen
 * manifest (#19) it serializes the TRD §15.1 baselines from the SAME golden
 * capture read-profile, measures each serialization deterministically (bytes,
 * deflated bytes, text tokens, image tokens, estimated USD), and computes the
 * required paired reductions with bootstrap confidence intervals:
 *
 *   text_reduction        = 1 - (candidate_text_tokens / baseline_text_tokens)
 *   input_cost_reduction  = 1 - (candidate_input_usd  / baseline_input_usd)
 *
 * Honesty rules, enforced structurally:
 *  - No model-dependent number is ever fabricated here. Grounding Recall@1,
 *    finding precision/recall, and latency come from Judgment Engine's model
 *    runs and enter the promotion decision (#24) as external evidence.
 *  - Token counters are PORTS. The defaults are clearly-labeled ESTIMATORS;
 *    Judgment Engine substitutes model-native counters (TRD §15.1 "model-native
 *    accounting"). Every report records which profile produced its numbers, and
 *    text and image tokens are never summed into one figure across families.
 *  - B4 (canonical full graph) is still serialized from the composite of the
 *    pipeline stages (validate → normalize → fuse → hierarchy → relations)
 *    rather than from the sealed snapshot the assembler in `builder.ts` now
 *    produces. Until that is rewired, its measurements stay marked
 *    `diagnosticOnly` and the promotion gate refuses them for PRD §7.1, so
 *    the token-reduction gate cannot pass as this repo stands.
 *  - B5 (task-focused view) renders through `renderFocusView` over the top-3
 *    heuristically-salient nodes; when a view comes back empty it reports
 *    `available: false` rather than a guessed number. The gate fails closed.
 *
 * Determinism: no wall-clock, randomness (outside the seeded bootstrap), or
 * locale-dependent formatting. Same manifest + captures + profiles + seed ⇒
 * byte-identical report and content hash (capability guard, #22).
 */

import { deflateRawSync } from "node:zlib";
import { canonicalize, sha256 } from "../canonical.js";
import type {
  CaptureAccessibilityNode,
  CaptureBundleReadProfile,
} from "../readprofile.js";
import {
  validateAndNormalize,
  fuseCapture,
  buildHierarchy,
  buildRelations,
  renderFocusView,
  heuristicSaliency,
  rankBySaliency,
} from "../pipeline/index.js";
import type { EvalCohort, RepresentationManifest } from "./manifest.js";
import {
  pairedBootstrapCI,
  type BootstrapOptions,
  type ConfidenceInterval,
  DEFAULT_BOOTSTRAP_ITERATIONS,
  DEFAULT_BOOTSTRAP_SEED,
} from "./stats.js";

// --- Baselines (TRD §15.1) ------------------------------------------------

export type BaselineId =
  | "b0_full_raw"
  | "b1_ax_only"
  | "b2_screenshot_only"
  | "b3_screenshot_ax"
  | "b4_full_graph"
  | "b5_focused_view";

export const BASELINE_IDS: readonly BaselineId[] = [
  "b0_full_raw",
  "b1_ax_only",
  "b2_screenshot_only",
  "b3_screenshot_ax",
  "b4_full_graph",
  "b5_focused_view",
] as const;

// --- Token / cost profiles (injected ports) --------------------------------

/** How a token count was produced. Estimates never masquerade as model-native. */
export type TokenAccountingKind = "model_native" | "estimate";

export interface TextTokenCounter {
  readonly id: string;
  readonly kind: TokenAccountingKind;
  countTextTokens(text: string): number;
}

export interface VisualTokenCounter {
  readonly id: string;
  readonly kind: TokenAccountingKind;
  countImageTokens(widthPx: number, heightPx: number): number;
}

export interface CostProfile {
  readonly id: string;
  readonly textInputUsdPerMTok: number;
  readonly imageInputUsdPerMTok: number;
}

/**
 * Default text estimator: ⌈UTF-16 length / 4⌉. A deliberately crude, clearly
 * labeled estimate for offline comparison; model-native counters replace it in
 * Judgment Engine runs.
 */
export const charEstimateTokenCounter: TextTokenCounter = {
  id: "char-quarter-estimate@1",
  kind: "estimate",
  countTextTokens: (text) => Math.ceil(text.length / 4),
};

/**
 * Patch-grid visual estimators. `patch16` matches a Qwen3-VL-style patch-16
 * budget; `patch28` matches a Claude-style ⌈w/28⌉×⌈h/28⌉ grid (core PRD §16 /
 * §4.2). Both are estimates parameterized purely by image dimensions; real
 * accounting is model-native and injected by Judgment Engine.
 */
export function patchGridVisualCounter(patchPx: number, id: string): VisualTokenCounter {
  return {
    id,
    kind: "estimate",
    countImageTokens: (w, h) => Math.ceil(w / patchPx) * Math.ceil(h / patchPx),
  };
}

export const patch16VisualCounter = patchGridVisualCounter(16, "patch16-grid-estimate@1");
export const patch28VisualCounter = patchGridVisualCounter(28, "patch28-grid-estimate@1");

/** Placeholder cost profile for offline runs; real rates are injected. */
export const unitCostProfile: CostProfile = {
  id: "unit-cost-placeholder@1",
  textInputUsdPerMTok: 1,
  imageInputUsdPerMTok: 1,
};

// --- Measurements -----------------------------------------------------------

export interface RepresentationMeasurement {
  readonly baseline: BaselineId;
  readonly available: boolean;
  /** Present when `available` is false, or when a caveat applies. */
  readonly reason?: string;
  /** True when the serialization approximates a not-yet-shipped stage (B4). */
  readonly diagnosticOnly?: boolean;
  readonly textBytes: number;
  /** deflateRaw(level 9) of the text serialization: a header-free, deterministic compressed size. */
  readonly deflateBytes: number;
  readonly textTokens: number;
  readonly imageCount: number;
  readonly imageTokens: number;
  readonly textUsd: number;
  readonly imageUsd: number;
  /** textUsd + imageUsd under ONE cost profile. Never a cross-family token sum. */
  readonly totalUsd: number;
}

export interface FixtureBenchmarkResult {
  readonly fixtureId: string;
  readonly setId: string;
  readonly cohorts: readonly EvalCohort[];
  readonly captureRef: string;
  readonly measurements: readonly RepresentationMeasurement[];
}

export interface ReductionEstimate {
  readonly metric: "text_tokens" | "input_usd";
  /** 1 - Σcandidate/Σbaseline over the paired fixtures (TRD §15.1). */
  readonly reduction: ConfidenceInterval;
}

export interface BaselineComparison {
  readonly candidate: BaselineId;
  readonly baseline: BaselineId;
  readonly available: boolean;
  readonly reason?: string;
  /** True when any contributing candidate measurement was diagnostic-only. */
  readonly diagnosticOnly?: boolean;
  readonly pairedFixtures: number;
  readonly reductions?: readonly ReductionEstimate[];
  readonly perCohort?: readonly CohortReduction[];
}

export interface CohortReduction {
  readonly cohort: EvalCohort;
  readonly pairedFixtures: number;
  readonly textReduction: number;
  readonly inputUsdReduction: number;
}

export interface BenchmarkProfiles {
  readonly textTokenizer: { readonly id: string; readonly kind: TokenAccountingKind };
  readonly visualTokenizer: { readonly id: string; readonly kind: TokenAccountingKind };
  readonly cost: CostProfile;
}

export interface RepresentationBenchmarkReport {
  readonly schemaVersion: "1.0.0";
  readonly manifestContentHash: string;
  readonly profiles: BenchmarkProfiles;
  readonly options: {
    readonly seed: number;
    readonly iterations: number;
    readonly baselineForReduction: BaselineId;
  };
  readonly fixtures: readonly FixtureBenchmarkResult[];
  readonly comparisons: readonly BaselineComparison[];
  readonly notes: readonly string[];
  readonly contentHash: string;
}

// --- Serializers ------------------------------------------------------------

interface Serialized {
  readonly text: string;
  readonly includeImages: boolean;
  readonly diagnosticOnly?: boolean;
  readonly unavailableReason?: string;
}

function serializeB0(capture: CaptureBundleReadProfile): Serialized {
  // Full raw structured context: everything the capture read-profile carries.
  return {
    text: canonicalize({
      route: capture.route,
      viewport: capture.viewport,
      documents: capture.documents,
      pageHealth: capture.pageHealth,
    }),
    includeImages: true,
  };
}

function axOutline(capture: CaptureBundleReadProfile): string {
  const lines: string[] = [];
  for (const doc of capture.documents) {
    const kept = doc.accessibilityNodes.filter((n) => !n.ignored);
    const keptIds = new Set(kept.map((n) => n.sourceId));
    const children = new Map<string, CaptureAccessibilityNode[]>();
    const roots: CaptureAccessibilityNode[] = [];
    for (const node of kept) {
      const parent = node.parentSourceId;
      if (parent !== undefined && keptIds.has(parent)) {
        const bucket = children.get(parent);
        if (bucket === undefined) children.set(parent, [node]);
        else bucket.push(node);
      } else {
        roots.push(node);
      }
    }
    const emit = (node: CaptureAccessibilityNode, depth: number): void => {
      const name = node.name !== undefined && node.name.length > 0 ? ` "${node.name}"` : "";
      const state =
        node.state !== undefined && Object.keys(node.state).length > 0
          ? ` ${canonicalize(node.state)}`
          : "";
      lines.push(`${"  ".repeat(depth)}- ${node.role ?? "generic"}${name}${state}`);
      for (const child of children.get(node.sourceId) ?? []) emit(child, depth + 1);
    };
    for (const root of roots) emit(root, 0);
  }
  return lines.join("\n");
}

function serializeB1(capture: CaptureBundleReadProfile): Serialized {
  return { text: axOutline(capture), includeImages: false };
}

function serializeB2(capture: CaptureBundleReadProfile): Serialized {
  return {
    text: `route ${capture.route} @ ${capture.viewport.widthCssPx}x${capture.viewport.heightCssPx}`,
    includeImages: true,
  };
}

function serializeB3(capture: CaptureBundleReadProfile): Serialized {
  return { text: axOutline(capture), includeImages: true };
}

function serializeB4(capture: CaptureBundleReadProfile): Serialized {
  const vn = validateAndNormalize(capture);
  if (!vn.ok) {
    return {
      text: "",
      includeImages: false,
      unavailableReason: `capture failed validate/normalize: ${vn.errors.map((e) => e.code).join(",")}`,
    };
  }
  const fusion = fuseCapture(capture, vn.normalized);
  const hier = buildHierarchy(fusion.nodes);
  const rel = buildRelations(fusion.nodes, hier.hierarchy);
  return {
    text: canonicalize({
      nodes: fusion.nodes,
      hierarchy: hier.hierarchy,
      regions: hier.regions,
      edges: rel.edges,
    }),
    includeImages: false,
    diagnosticOnly: true,
  };
}

function serializeB5(capture: CaptureBundleReadProfile): Serialized {
  const vn = validateAndNormalize(capture);
  if (!vn.ok) {
    return {
      text: "",
      includeImages: false,
      unavailableReason: `capture failed validate/normalize: ${vn.errors.map((e) => e.code).join(",")}`,
    };
  }
  const fusion = fuseCapture(capture, vn.normalized);
  const hier = buildHierarchy(fusion.nodes);
  const rel = buildRelations(fusion.nodes, hier.hierarchy);
  // Benchmark manifests carry no task refs today, so B5 focuses on the top-3
  // heuristically-salient nodes, a deterministic, documented proxy for
  // "task-relevant" until manifests grow task refs (#41).
  const refs = rankBySaliency(heuristicSaliency(fusion.nodes)).slice(0, 3);
  const view = renderFocusView(
    { nodes: fusion.nodes, hierarchy: hier.hierarchy, regions: hier.regions, edges: rel.edges },
    refs,
  );
  if (view.meta.emptyReason !== undefined) {
    return { text: "", includeImages: false, unavailableReason: view.meta.emptyReason };
  }
  return { text: view.text, includeImages: false };
}

// --- Runner -----------------------------------------------------------------

/** Resolves a manifest `captureRef` to its golden capture read-profile bytes. */
export interface CaptureResolver {
  resolve(captureRef: string): CaptureBundleReadProfile;
}

export interface BenchmarkRunOptions extends BootstrapOptions {
  readonly textTokenizer?: TextTokenCounter;
  readonly visualTokenizer?: VisualTokenCounter;
  readonly cost?: CostProfile;
  readonly baselineForReduction?: BaselineId;
}

const B4_DIAGNOSTIC_NOTE =
  "b4_full_graph is a pre-assembler composite (validate→normalize→fuse→hierarchy→relations); " +
  "diagnostic only until the sealed-snapshot assembler (TRD §8.8) serializes the canonical snapshot end-to-end";

export function runRepresentationBenchmark(
  manifest: RepresentationManifest,
  resolver: CaptureResolver,
  options: BenchmarkRunOptions = {},
): RepresentationBenchmarkReport {
  const tokenizer = options.textTokenizer ?? charEstimateTokenCounter;
  const visual = options.visualTokenizer ?? patch16VisualCounter;
  const cost = options.cost ?? unitCostProfile;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const iterations = options.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  const baselineForReduction = options.baselineForReduction ?? "b0_full_raw";

  const measureOne = (
    baseline: BaselineId,
    serialized: Serialized,
    capture: CaptureBundleReadProfile,
  ): RepresentationMeasurement => {
    if (serialized.unavailableReason !== undefined) {
      return {
        baseline,
        available: false,
        reason: serialized.unavailableReason,
        textBytes: 0,
        deflateBytes: 0,
        textTokens: 0,
        imageCount: 0,
        imageTokens: 0,
        textUsd: 0,
        imageUsd: 0,
        totalUsd: 0,
      };
    }
    const textBytes = Buffer.byteLength(serialized.text, "utf8");
    const deflateBytes =
      serialized.text.length === 0
        ? 0
        : deflateRawSync(Buffer.from(serialized.text, "utf8"), { level: 9 }).length;
    const textTokens = tokenizer.countTextTokens(serialized.text);
    const evidence = serialized.includeImages ? (capture.screenshotEvidence ?? []) : [];
    let imageTokens = 0;
    for (const shot of evidence) {
      imageTokens += visual.countImageTokens(shot.widthImagePx, shot.heightImagePx);
    }
    const textUsd = (textTokens / 1_000_000) * cost.textInputUsdPerMTok;
    const imageUsd = (imageTokens / 1_000_000) * cost.imageInputUsdPerMTok;
    const base: RepresentationMeasurement = {
      baseline,
      available: true,
      textBytes,
      deflateBytes,
      textTokens,
      imageCount: evidence.length,
      imageTokens,
      textUsd,
      imageUsd,
      totalUsd: textUsd + imageUsd,
    };
    return serialized.diagnosticOnly === true
      ? { ...base, diagnosticOnly: true, reason: B4_DIAGNOSTIC_NOTE }
      : base;
  };

  const fixtures: FixtureBenchmarkResult[] = [];
  for (const set of manifest.sets) {
    for (const entry of set.fixtures) {
      const capture = resolver.resolve(entry.captureRef);
      const measurements: RepresentationMeasurement[] = [
        measureOne("b0_full_raw", serializeB0(capture), capture),
        measureOne("b1_ax_only", serializeB1(capture), capture),
        measureOne("b2_screenshot_only", serializeB2(capture), capture),
        measureOne("b3_screenshot_ax", serializeB3(capture), capture),
        measureOne("b4_full_graph", serializeB4(capture), capture),
        measureOne("b5_focused_view", serializeB5(capture), capture),
      ];
      fixtures.push({
        fixtureId: entry.fixtureId,
        setId: entry.setId,
        cohorts: entry.cohorts,
        captureRef: entry.captureRef,
        measurements,
      });
    }
  }

  const comparisons: BaselineComparison[] = [];
  const candidates = BASELINE_IDS.filter((b) => b !== baselineForReduction);
  for (const candidate of candidates) {
    comparisons.push(
      compareBaselines(fixtures, candidate, baselineForReduction, { seed, iterations }),
    );
  }

  const unsealed = {
    schemaVersion: "1.0.0" as const,
    manifestContentHash: manifest.manifestContentHash,
    profiles: {
      textTokenizer: { id: tokenizer.id, kind: tokenizer.kind },
      visualTokenizer: { id: visual.id, kind: visual.kind },
      cost,
    },
    options: { seed, iterations, baselineForReduction },
    fixtures,
    comparisons,
    notes: [
      "token counts are per the recorded profiles; text and image tokens are never summed across model families (TRD §15.1)",
      "model-dependent metrics (grounding, finding quality, latency) are external evidence supplied by Judgment Engine, never computed here",
      B4_DIAGNOSTIC_NOTE,
    ],
  };
  const contentHash = sha256(canonicalize(unsealed));
  return { ...unsealed, contentHash };
}

interface TokenPair {
  readonly baseTokens: number;
  readonly candTokens: number;
  readonly baseUsd: number;
  readonly candUsd: number;
  readonly cohorts: readonly EvalCohort[];
}

function compareBaselines(
  fixtures: readonly FixtureBenchmarkResult[],
  candidate: BaselineId,
  baseline: BaselineId,
  bootstrap: BootstrapOptions,
): BaselineComparison {
  const pairs: TokenPair[] = [];
  let diagnostic = false;
  for (const fixture of fixtures) {
    const cand = fixture.measurements.find((m) => m.baseline === candidate);
    const base = fixture.measurements.find((m) => m.baseline === baseline);
    if (cand === undefined || base === undefined) continue;
    if (!cand.available || !base.available) continue;
    if (cand.diagnosticOnly === true) diagnostic = true;
    pairs.push({
      baseTokens: base.textTokens,
      candTokens: cand.textTokens,
      baseUsd: base.totalUsd,
      candUsd: cand.totalUsd,
      cohorts: fixture.cohorts,
    });
  }
  if (pairs.length === 0) {
    return {
      candidate,
      baseline,
      available: false,
      reason: "no paired fixtures where both representations were available",
      pairedFixtures: 0,
    };
  }

  const ratioReduction = (
    sample: readonly TokenPair[],
    pick: (p: TokenPair) => readonly [number, number],
  ): number => {
    let baseSum = 0;
    let candSum = 0;
    for (const p of sample) {
      const [b, c] = pick(p);
      baseSum += b;
      candSum += c;
    }
    return baseSum <= 0 ? 0 : 1 - candSum / baseSum;
  };

  const textCI = pairedBootstrapCI(
    pairs,
    (s) => ratioReduction(s, (p) => [p.baseTokens, p.candTokens]),
    bootstrap,
  );
  const usdCI = pairedBootstrapCI(
    pairs,
    (s) => ratioReduction(s, (p) => [p.baseUsd, p.candUsd]),
    bootstrap,
  );

  // Per-cohort reductions (TRD §15.1/§15.3: publish per-cohort so aggregates
  // cannot mask a single-cohort regression). Point estimates only, because cohorts are
  // small; the gate treats any negative cohort as a regression signal.
  const cohortIds = [...new Set(pairs.flatMap((p) => p.cohorts))].sort();
  const perCohort: CohortReduction[] = [];
  for (const cohort of cohortIds) {
    const inCohort = pairs.filter((p) => p.cohorts.includes(cohort));
    if (inCohort.length === 0) continue;
    perCohort.push({
      cohort,
      pairedFixtures: inCohort.length,
      textReduction: ratioReduction(inCohort, (p) => [p.baseTokens, p.candTokens]),
      inputUsdReduction: ratioReduction(inCohort, (p) => [p.baseUsd, p.candUsd]),
    });
  }

  const comparison: BaselineComparison = {
    candidate,
    baseline,
    available: true,
    pairedFixtures: pairs.length,
    reductions: [
      { metric: "text_tokens", reduction: textCI },
      { metric: "input_usd", reduction: usdCI },
    ],
    perCohort,
  };
  return diagnostic ? { ...comparison, diagnosticOnly: true, reason: B4_DIAGNOSTIC_NOTE } : comparison;
}

// --- Deterministic markdown render -------------------------------------------

/** Deterministic, timestamp-free markdown summary of a benchmark report. */
export function renderBenchmarkMarkdown(report: RepresentationBenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`# Representation benchmark (${report.contentHash.slice(0, 15)})`);
  lines.push("");
  lines.push(`manifest: \`${report.manifestContentHash}\``);
  lines.push(
    `profiles: text=\`${report.profiles.textTokenizer.id}\` (${report.profiles.textTokenizer.kind}), ` +
      `visual=\`${report.profiles.visualTokenizer.id}\` (${report.profiles.visualTokenizer.kind}), ` +
      `cost=\`${report.profiles.cost.id}\``,
  );
  lines.push("");
  lines.push(`## Reductions vs \`${report.options.baselineForReduction}\``);
  lines.push("");
  lines.push("| candidate | paired | text_reduction [95% CI] | input_usd_reduction [95% CI] | caveat |");
  lines.push("|---|---|---|---|---|");
  for (const c of report.comparisons) {
    if (!c.available || c.reductions === undefined) {
      lines.push(`| ${c.candidate} | 0 | — | — | ${c.reason ?? "unavailable"} |`);
      continue;
    }
    const text = c.reductions.find((r) => r.metric === "text_tokens");
    const usd = c.reductions.find((r) => r.metric === "input_usd");
    const fmt = (ci: ConfidenceInterval): string =>
      `${(ci.point * 100).toFixed(1)}% [${(ci.lower * 100).toFixed(1)}%, ${(ci.upper * 100).toFixed(1)}%]`;
    lines.push(
      `| ${c.candidate} | ${c.pairedFixtures} | ${text !== undefined ? fmt(text.reduction) : "—"} | ` +
        `${usd !== undefined ? fmt(usd.reduction) : "—"} | ${c.diagnosticOnly === true ? "diagnostic-only" : ""} |`,
    );
  }
  lines.push("");
  lines.push("## Notes");
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push("");
  return lines.join("\n");
}
