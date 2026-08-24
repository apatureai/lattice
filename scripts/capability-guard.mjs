#!/usr/bin/env node
/**
 * Capability guard (issue #22).
 *
 * The single most load-bearing invariant of this repo is that `@apatureai/lattice`
 * is a deterministic, sandboxed library with NO model, browser, network, or DB
 * capability (PRD §12, TRD §2/§3.1, ARCHITECTURE §1/§2). This script makes that
 * boundary a failing CI gate instead of prose. It checks five things:
 *
 *  1. Dependency boundary: every runtime dependency of the published package
 *     must be on the allowlist. New runtime deps require an explicit, justified
 *     allowlist entry visible in review. Names that look like a network/HTTP
 *     client, browser/CDP driver, model/inference SDK, or DB client are denied.
 *
 *  2. Import boundary: no file in the core package may import a browser, network
 *     or model module, including Node's own networking built-ins, and none may
 *     import the capture adapter. The dependency check alone cannot see this,
 *     because a workspace sibling would resolve without a manifest entry.
 *
 *  3. Adapter placement: `@apatureai/lattice-capture` exists precisely so the
 *     capture producer can drive a browser without the core gaining that
 *     capability. Its browser dependency must stay optional (a peer), so
 *     installing the core never pulls a browser in, and it must be a strictly
 *     one-way dependency: the adapter reads the core, never the reverse.
 *
 *  4. Determinism: hashed/canonical code paths (build/serialize/hash/view) must
 *     not read wall-clock, randomness, or locale-dependent formatting (TRD §8,
 *     §9). Wall-clock belongs only to diagnostics / delta `createdAt`, never to
 *     hashed snapshot fields (TRD §5.1, §9.2).
 *
 *  5. Locale-independent ordering, across the whole core package rather than a
 *     named list of files. Ordering is not a formatting detail here: the order
 *     candidates are finalized in decides their ref ordinals, the winner of a
 *     tie between two claims is the value that gets sealed, and the order of a
 *     rendered list is view bytes. Any of those going through `localeCompare`
 *     makes the snapshot id a function of `LC_ALL` and of the ICU build, which
 *     is what content addressing exists to rule out. Use `compareCodeUnits`
 *     from `canonical.ts`.
 *
 * This script uses only Node built-ins; it performs no network access itself.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgRoot = join(repoRoot, "packages", "schema");

const errors = [];
const fail = (msg) => errors.push(msg);

// --- 1. Dependency boundary ---------------------------------------------

/**
 * Runtime dependencies the package is permitted to ship. Each entry needs a
 * justification. Adding a dependency here is a visible, reviewable decision.
 */
const RUNTIME_DEP_ALLOWLIST = {
  ajv: "Pure in-process JSON Schema validation. No network/model/browser/DB.",
  "ajv-formats": "Format keywords for ajv. Pure, in-process.",
};

/** Substrings that mark a forbidden capability category in a dependency name. */
const FORBIDDEN_DEP_PATTERNS = [
  // network / HTTP clients
  "axios", "node-fetch", "got", "undici", "superagent", "request", "ky",
  // browser / CDP / automation
  "puppeteer", "playwright", "selenium", "chrome-remote", "webdriver", "cdp",
  // model / inference SDKs
  "openai", "anthropic", "@anthropic", "langchain", "cohere", "replicate",
  "@huggingface", "onnxruntime", "tensorflow", "@tensorflow",
  // databases / stores
  "pg", "mysql", "mysql2", "mongodb", "mongoose", "redis", "ioredis",
  "sqlite", "better-sqlite3", "prisma", "knex", "sequelize", "typeorm",
];

const pkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const runtimeDeps = Object.keys(pkgJson.dependencies ?? {});

for (const dep of runtimeDeps) {
  if (!(dep in RUNTIME_DEP_ALLOWLIST)) {
    fail(
      `Runtime dependency "${dep}" is not on the allowlist. Add it to ` +
        `RUNTIME_DEP_ALLOWLIST in scripts/capability-guard.mjs with a justification, ` +
        `or remove it (TRD §3.1).`,
    );
  }
  const lower = dep.toLowerCase();
  for (const pattern of FORBIDDEN_DEP_PATTERNS) {
    if (lower === pattern || lower.includes(pattern)) {
      fail(
        `Runtime dependency "${dep}" matches forbidden capability pattern ` +
          `"${pattern}" (network/browser/model/DB). UI Graph must not ship it (TRD §3.1).`,
      );
    }
  }
}

// --- 2. Import boundary in the core package ------------------------------

/**
 * Module specifiers the core library may never import. A workspace sibling
 * resolves without appearing in `dependencies`, so the manifest check above
 * cannot see it; this reads the source.
 */
const FORBIDDEN_IMPORTS = [
  { re: /^playwright(-core)?$/, why: "browser driver" },
  { re: /^puppeteer(-core)?$/, why: "browser driver" },
  { re: /^chrome-remote-interface$/, why: "CDP client" },
  { re: /^selenium-webdriver$/, why: "browser driver" },
  { re: /^node:(http|https|net|tls|dgram|dns|http2)$/, why: "Node networking built-in" },
  { re: /^(http|https|net|tls|dgram|dns|http2)$/, why: "Node networking built-in" },
  { re: /^undici$/, why: "HTTP client" },
  { re: /^@apatureai\/lattice-capture$/, why: "the capture adapter, which drives a browser" },
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

function importedSpecifiers(text) {
  const found = new Set();
  for (const match of text.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) found.add(specifier);
  }
  return found;
}

const coreSources = collectTs(join(pkgRoot, "src"));
for (const file of coreSources) {
  const text = readFileSync(file, "utf8");
  for (const specifier of importedSpecifiers(text)) {
    for (const { re, why } of FORBIDDEN_IMPORTS) {
      if (re.test(specifier)) {
        fail(
          `${relative(repoRoot, file)} imports "${specifier}" (${why}). The core library ` +
            `has no browser/network/model capability; capture belongs in ` +
            `packages/capture, outside this boundary (TRD §3.1).`,
        );
      }
    }
  }
}

// --- 3. The capture adapter stays outside the boundary -------------------

const capturePkgPath = join(repoRoot, "packages", "capture", "package.json");
let capturePkg;
try {
  capturePkg = JSON.parse(readFileSync(capturePkgPath, "utf8"));
} catch {
  fail(
    "packages/capture/package.json is missing. The capture adapter is what keeps " +
      "browser capability out of the core; if it moved, this guard must move with it.",
  );
}

if (capturePkg !== undefined) {
  const captureRuntimeDeps = Object.keys(capturePkg.dependencies ?? {});
  for (const dep of captureRuntimeDeps) {
    const lower = dep.toLowerCase();
    for (const pattern of FORBIDDEN_DEP_PATTERNS) {
      if (lower === pattern || lower.includes(pattern)) {
        fail(
          `packages/capture declares "${dep}" as a hard runtime dependency. A browser ` +
            `library must stay an OPTIONAL peer dependency, so that consuming the ` +
            `adapter's pure transform never installs a browser.`,
        );
      }
    }
  }

  const peers = capturePkg.peerDependencies ?? {};
  const peerMeta = capturePkg.peerDependenciesMeta ?? {};
  if (!("playwright-core" in peers)) {
    fail("packages/capture must declare playwright-core as a peer dependency, not a hard one.");
  } else if (peerMeta["playwright-core"]?.optional !== true) {
    fail("packages/capture must mark the playwright-core peer dependency optional.");
  }

  if (Object.keys(pkgJson.dependencies ?? {}).includes(capturePkg.name)) {
    fail(
      `The core package depends on "${capturePkg.name}". The dependency is one-way by ` +
        `design: the adapter reads the core, never the reverse.`,
    );
  }
}

/** Source with comments removed, so prose naming a banned API does not trip a guard. */
const stripComments = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

// --- 4. Determinism guard -----------------------------------------------

/**
 * Source files whose output participates in the content hash / canonical form,
 * and which therefore may not read a clock or a random source at all.
 *
 * `builder.ts` and `pipeline/delta.ts` are deliberately absent: the builder
 * stamps `diagnostics.builtAt` and measures stage timings, both outside the
 * sealed snapshot, and the delta writer uses a constant `new Date(0)`. Every
 * other stage between a capture bundle and a rendered view is listed.
 */
const HASHED_PATH_FILES = [
  "canonical.ts",
  "query.ts",
  "pipeline/normalize.ts",
  "pipeline/fuse.ts",
  "pipeline/hierarchy.ts",
  "pipeline/relations.ts",
  "pipeline/dna-match.ts",
  "pipeline/views.ts",
  "pipeline/lineage.ts",
  "pipeline/evidence-request.ts",
  "pipeline/saliency.ts",
];

/**
 * Patterns that introduce non-determinism. Each has a human-readable reason.
 * Hashed code paths must use none of these.
 */
const NONDETERMINISM_PATTERNS = [
  { re: /\bDate\.now\s*\(/, reason: "wall-clock (Date.now)" },
  { re: /\bnew\s+Date\b/, reason: "wall-clock (new Date)" },
  { re: /\bperformance\.now\s*\(/, reason: "wall-clock (performance.now)" },
  { re: /\bMath\.random\s*\(/, reason: "randomness (Math.random)" },
  { re: /\bcrypto\.randomUUID\s*\(/, reason: "randomness (crypto.randomUUID)" },
  { re: /\bcrypto\.randomBytes\s*\(/, reason: "randomness (crypto.randomBytes)" },
  { re: /\.toLocaleString\s*\(/, reason: "locale-dependent formatting (toLocaleString)" },
  { re: /\.toLocaleDateString\s*\(/, reason: "locale-dependent formatting" },
  { re: /\blocaleCompare\s*\(/, reason: "locale-dependent sort (localeCompare)" },
];

const srcDir = join(pkgRoot, "src");
for (const file of HASHED_PATH_FILES) {
  const full = join(srcDir, file);
  let text;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    fail(`Determinism guard expected hashed-path file "${file}" but it is missing.`);
    continue;
  }
  // Strip comments so prose mentioning these terms does not trip the guard.
  const code = stripComments(text);
  for (const { re, reason } of NONDETERMINISM_PATTERNS) {
    if (re.test(code)) {
      fail(
        `Hashed/canonical code path src/${file} uses ${reason}. Non-deterministic ` +
          `sources are forbidden in build/serialize/hash/view paths (TRD §8, §9). ` +
          `Wall-clock belongs only to diagnostics / delta createdAt (TRD §5.1, §9.2).`,
      );
    }
  }
}

// --- 5. Locale-independent ordering, package-wide ------------------------

/**
 * Locale-sensitive APIs, banned in every source file of the core package. The
 * check above names four files; this one names none, because a comparison that
 * consults the process locale is a determinism bug wherever it sits: fusion
 * tie-breaks, hierarchy and relation ordering, delta op ordering and view list
 * ordering all reach the content hash or the rendered bytes.
 *
 * `canonical.ts` documents the rule and exports `compareCodeUnits`, which is
 * the replacement. The guard skips its own prose (comment lines) so that
 * explaining the rule does not violate it.
 */
const LOCALE_SENSITIVE_PATTERNS = [
  { re: /\.localeCompare\s*\(/, reason: "locale-dependent sort (localeCompare); use compareCodeUnits" },
  { re: /\.toLocaleString\s*\(/, reason: "locale-dependent formatting (toLocaleString)" },
  { re: /\.toLocaleDateString\s*\(/, reason: "locale-dependent formatting (toLocaleDateString)" },
  { re: /\.toLocaleTimeString\s*\(/, reason: "locale-dependent formatting (toLocaleTimeString)" },
  { re: /\bnew\s+Intl\.Collator\b/, reason: "locale-dependent sort (Intl.Collator)" },
];

for (const file of collectTs(srcDir)) {
  const code = stripComments(readFileSync(file, "utf8"));
  for (const { re, reason } of LOCALE_SENSITIVE_PATTERNS) {
    if (re.test(code)) {
      fail(
        `${relative(repoRoot, file)} uses ${reason}. Ordering and formatting in this ` +
          `package must not depend on the process locale: the same capture would seal ` +
          `to a different contentHash under a different LC_ALL or ICU build (TRD §8, §9).`,
      );
    }
  }
}

// Sanity: the guard found the source tree at all.
const srcFiles = collectTs(srcDir);
if (srcFiles.length === 0) {
  fail(`Capability guard found no source files under ${relative(repoRoot, srcDir)}.`);
}

function collectTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...collectTs(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

// --- Report --------------------------------------------------------------

if (errors.length > 0) {
  console.error("Capability guard FAILED:\n");
  for (const e of errors) console.error("  ✗ " + e);
  console.error(`\n${errors.length} violation(s). See scripts/capability-guard.mjs and CONTRIBUTING.md.`);
  process.exit(1);
}

console.log(
  "Capability guard passed: no forbidden capability, no locale-dependent ordering, " +
    "no clock or randomness on the hashed path.",
);
