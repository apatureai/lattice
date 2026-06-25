#!/usr/bin/env node
/**
 * Capability guard (issue #22).
 *
 * The single most load-bearing invariant of this repo is that `@apature/ui-graph`
 * is a deterministic, sandboxed library with NO model, browser, network, or DB
 * capability (PRD §12, TRD §2/§3.1, ARCHITECTURE §1/§2). This script makes that
 * boundary a failing CI gate instead of prose. It checks two things:
 *
 *  1. Dependency boundary: every runtime dependency of the published package
 *     must be on the allowlist. New runtime deps require an explicit, justified
 *     allowlist entry visible in review. Names that look like a network/HTTP
 *     client, browser/CDP driver, model/inference SDK, or DB client are denied.
 *
 *  2. Determinism: hashed/canonical code paths (build/serialize/hash/view) must
 *     not read wall-clock, randomness, or locale-dependent formatting (TRD §8,
 *     §9). Wall-clock belongs only to diagnostics / delta `createdAt`, never to
 *     hashed snapshot fields (TRD §5.1, §9.2).
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

// --- 2. Determinism guard -----------------------------------------------

/** Source files whose output participates in the content hash / canonical form. */
const HASHED_PATH_FILES = ["canonical.ts"];

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
  // Strip line comments so prose mentioning these terms does not trip the guard.
  const code = text
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
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

console.log("Capability guard passed: no forbidden capability or non-deterministic source.");
