/**
 * Deterministic statistics for the representation benchmark (#20; TRD §15.1).
 *
 * TRD §15.1 requires paired fixtures and bootstrap 95% confidence intervals,
 * and the promotion gate (#24) must not promote on point estimates that a
 * resample would overturn. This module supplies exactly that machinery in a
 * form the capability guard (#22) accepts: a SEEDED deterministic PRNG (never
 * `Math.random`), no wall-clock, no locale-dependent formatting. Same inputs +
 * same seed ⇒ byte-identical intervals.
 *
 * Two tools:
 *  - `pairedBootstrapCI`: percentile bootstrap over paired per-fixture values
 *    for ratio-style statistics (e.g. `text_reduction = 1 - Σcand/Σbase`).
 *  - `mcnemarExact`: exact two-sided McNemar test on paired binary outcomes
 *    (e.g. per-item grounding hit/miss under two representations). Judgment
 *    Engine supplies the discordant counts from its model runs; this module
 *    never fabricates model measurements.
 */

// --- Seeded PRNG ----------------------------------------------------------

/**
 * mulberry32 is a small, well-distributed 32-bit PRNG. Chosen for determinism and
 * portability, not cryptography (the bootstrap needs reproducible resampling,
 * nothing more).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Paired bootstrap -----------------------------------------------------

export interface ConfidenceInterval {
  /** Point estimate of the statistic on the full sample. */
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
  /** Two-sided confidence level, e.g. 0.95 (TRD §15.1). */
  readonly level: number;
  readonly iterations: number;
  readonly seed: number;
  /** Number of pairs the statistic was computed over. */
  readonly pairs: number;
}

export interface BootstrapOptions {
  readonly iterations?: number;
  readonly seed?: number;
  readonly level?: number;
}

export const DEFAULT_BOOTSTRAP_ITERATIONS = 2000;
export const DEFAULT_BOOTSTRAP_SEED = 42;
export const DEFAULT_BOOTSTRAP_LEVEL = 0.95;

/**
 * Percentile bootstrap CI for an arbitrary statistic over paired observations.
 * Pairs are resampled with replacement (fixture-level resampling, which is what
 * "paired fixtures" in TRD §15.1 calls for); the statistic runs on each
 * replicate; the interval is the (α/2, 1−α/2) percentile of the replicates.
 *
 * Deterministic: same pairs + options ⇒ identical interval.
 */
export function pairedBootstrapCI<T>(
  pairs: readonly T[],
  statistic: (sample: readonly T[]) => number,
  options: BootstrapOptions = {},
): ConfidenceInterval {
  if (pairs.length === 0) {
    throw new Error("pairedBootstrapCI: cannot bootstrap an empty sample");
  }
  const iterations = options.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const level = options.level ?? DEFAULT_BOOTSTRAP_LEVEL;
  if (level <= 0 || level >= 1) {
    throw new Error(`pairedBootstrapCI: level must be in (0,1), got ${level}`);
  }

  const point = statistic(pairs);
  const rand = mulberry32(seed);
  const replicates: number[] = new Array<number>(iterations);
  const sample: T[] = new Array<T>(pairs.length);
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < pairs.length; j++) {
      const idx = Math.floor(rand() * pairs.length);
      // idx is in [0, length) by construction; the assertion keeps
      // noUncheckedIndexedAccess honest without a runtime branch cost.
      sample[j] = pairs[idx] as T;
    }
    replicates[i] = statistic(sample);
  }
  replicates.sort((a, b) => a - b);

  const alpha = 1 - level;
  const lowerIdx = Math.floor((alpha / 2) * (iterations - 1));
  const upperIdx = Math.floor((1 - alpha / 2) * (iterations - 1));
  return {
    point,
    lower: replicates[lowerIdx] as number,
    upper: replicates[upperIdx] as number,
    level,
    iterations,
    seed,
    pairs: pairs.length,
  };
}

// --- Exact McNemar --------------------------------------------------------

export interface McNemarResult {
  /** Exact two-sided p-value from the binomial(n, 0.5) discordant-pair test. */
  readonly pValue: number;
  /** Total discordant pairs (aOnly + bOnly). */
  readonly discordant: number;
  readonly aOnly: number;
  readonly bOnly: number;
}

/**
 * Exact two-sided McNemar test on paired binary outcomes.
 *
 * `aOnly` = items representation A got right and B got wrong; `bOnly` = the
 * reverse. Concordant pairs carry no information about the difference and are
 * not needed. With zero discordant pairs the representations are
 * indistinguishable on this sample and p = 1.
 *
 * Computed in log space so large counts do not overflow; fully deterministic.
 */
export function mcnemarExact(aOnly: number, bOnly: number): McNemarResult {
  if (!Number.isInteger(aOnly) || !Number.isInteger(bOnly) || aOnly < 0 || bOnly < 0) {
    throw new Error(`mcnemarExact: counts must be non-negative integers, got (${aOnly}, ${bOnly})`);
  }
  const n = aOnly + bOnly;
  if (n === 0) {
    return { pValue: 1, discordant: 0, aOnly, bOnly };
  }

  // log(k!) table up to n, built iteratively (deterministic float ops).
  const logFact: number[] = new Array<number>(n + 1);
  logFact[0] = 0;
  for (let k = 1; k <= n; k++) {
    logFact[k] = (logFact[k - 1] as number) + Math.log(k);
  }
  const logChoose = (nn: number, kk: number): number =>
    (logFact[nn] as number) - (logFact[kk] as number) - (logFact[nn - kk] as number);

  const logHalfPowN = n * Math.log(0.5);
  const k = Math.min(aOnly, bOnly);
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    tail += Math.exp(logChoose(n, i) + logHalfPowN);
  }
  const p = Math.min(1, 2 * tail);
  return { pValue: p, discordant: n, aOnly, bOnly };
}
