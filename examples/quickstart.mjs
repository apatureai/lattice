#!/usr/bin/env node
/**
 * End-to-end example: synthetic capture evidence in, queryable scene graph out.
 *
 * Run from the repo root, after `pnpm install && pnpm build`:
 *
 *   node examples/quickstart.mjs
 *
 * No credentials, no network, no browser. It generates a deterministic synthetic
 * page capture, builds one sealed content-addressed snapshot, asks that snapshot
 * five bounded questions through `queryUiGraph`, measures every answer against
 * the capture it came from, and writes the artifacts to `out/`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildUiGraph,
  canonicalize,
  queryUiGraph,
  resolveElementRefInSnapshot,
  syntheticCapture,
  syntheticDna,
  SYNTHETIC_SCREENSHOT_ARTIFACT_REF,
  validateView,
  formatErrors,
} from "../packages/schema/dist/index.js";

const OUT_DIR = fileURLToPath(new URL("../out/", import.meta.url));

const bytes = (value) => Buffer.byteLength(value, "utf8");
const tokens = (value) => Math.ceil(value.length / 4);
const pct = (part, whole) => `${(100 * (1 - part / whole)).toFixed(1)}%`;
const pad = (value, width) => String(value).padEnd(width);
const padLeft = (value, width) => String(value).padStart(width);

// --- 1. Synthetic capture evidence ------------------------------------------

const capture = syntheticCapture();
const doc = capture.documents[0];
const captureJson = canonicalize(capture);

console.log("1. Synthetic capture (no browser was involved)");
console.log(`   route              ${capture.route}  @ ${capture.viewport.widthCssPx}x${capture.viewport.heightCssPx} css px`);
console.log(`   dom/layout nodes   ${doc.domLayoutNodes.length}`);
console.log(`   accessibility      ${doc.accessibilityNodes.length}`);
console.log(`   text runs          ${doc.textRuns.length}`);
console.log(`   canonical JSON     ${bytes(captureJson)} bytes (${tokens(captureJson)} est. tokens)`);
console.log("");

// --- 2. Build one sealed, content-addressed snapshot -------------------------

const { snapshot, diagnostics } = await buildUiGraph({
  capture,
  dna: syntheticDna(),
  options: {
    builderVersion: "ui-graph-builder@0.1.0",
    schemaVersion: "1.0.0",
    relationPolicyVersion: "relations@1",
    dnaProjectionVersion: "dna-projection@1",
    redactionPolicyVersion: "redaction@1",
    useMode: "offline_eval",
    maxNodes: 2000,
    maxPersistedEdgesPerNode: 8,
    repeatedRegionThreshold: 3,
    textPolicy: "truncate",
    includeHiddenExplanatoryNodes: false,
  },
});

console.log("2. buildUiGraph — fuse, hierarchy, relations, DNA projection, seal");
console.log(`   snapshotId         ${snapshot.snapshotId}`);
console.log(`   contentHash        ${snapshot.contentHash}`);
console.log(`   nodes / edges      ${snapshot.metrics.graph.nodes} / ${snapshot.metrics.graph.edges}`);
console.log(`   regions            ${snapshot.metrics.graph.regions}`);
console.log(`   retained conflicts ${snapshot.metrics.graph.conflictCount}   (DOM said "link", accessibility said "button" — both kept)`);
console.log(`   canonical JSON     ${diagnostics.canonicalJsonBytes} bytes`);
console.log("");

// --- 3. Ask the snapshot bounded questions ----------------------------------

const named = (name) => {
  const node = snapshot.nodes.find((n) => n.semantics.name === name);
  if (node === undefined) throw new Error(`no node named ${name}`);
  return node.elementRef;
};
const ctaRef = named("New review");

const spec = (kind, extra = {}) => ({
  kind,
  maxTextTokens: 100_000,   // effectively unbounded; section 4 shows a tight budget
  maxNodes: 400,
  maxEdges: 400,
  maxCrops: 0,
  includeSensitive: false,
  tokenizerProfile: "char-quarter-estimate@1",
  rendererVersion: "ui-graph-renderer@0.2.0",
  ...extra,
});

const queries = [
  ["summary", spec("summary")],
  ["actionMap", spec("actionMap")],
  ["violations", spec("violations")],
  ["focus", spec("focus", { refs: [ctaRef] })],
  ["patchContext", spec("patchContext", { refs: [ctaRef], maxCrops: 2 })],
];

console.log(`3. queryUiGraph — five views of the same snapshot (focus/patchContext on ${ctaRef})`);
console.log(`   ${pad("view", 14)}${padLeft("bytes", 8)}${padLeft("est.tok", 9)}${padLeft("nodes", 7)}${padLeft("vs capture", 12)}  truncation`);

const views = new Map();
for (const [name, viewSpec] of queries) {
  const view = queryUiGraph({ snapshot, spec: viewSpec, screenshotArtifactRef: SYNTHETIC_SCREENSHOT_ARTIFACT_REF });
  const check = validateView(view);
  if (!check.valid) throw new Error(`${name} view failed schema validation: ${formatErrors(check.errors)}`);
  views.set(name, view);
  const reason = view.truncation.truncated ? view.truncation.reasons[0] : "none";
  console.log(
    `   ${pad(name, 14)}${padLeft(view.budget.serializedBytes, 8)}${padLeft(view.budget.estimatedTextTokens, 9)}` +
      `${padLeft(view.budget.includedNodes, 7)}${padLeft(pct(view.budget.serializedBytes, bytes(captureJson)), 12)}  ${reason}`,
  );
}
console.log("   (\"vs capture\" is the reduction against the canonical capture JSON above.)");
console.log("");

// --- 4. A budget truncates; it never throws ---------------------------------

const budgeted = queryUiGraph({ snapshot, spec: spec("summary", { maxTextTokens: 1000 }) });
console.log("4. The same summary under maxTextTokens: 1000 — budgets truncate, they never throw");
console.log(`   est. tokens        ${budgeted.budget.estimatedTextTokens} (was ${views.get("summary").budget.estimatedTextTokens})`);
console.log(`   nodes described    ${budgeted.budget.includedNodes} (was ${views.get("summary").budget.includedNodes})`);
for (const reason of budgeted.truncation.reasons) console.log(`   reason             ${reason}`);
console.log("");

// --- 5. What a view actually says -------------------------------------------

const actionMap = views.get("actionMap");
const affordances = JSON.parse(actionMap.text).actions;
console.log(`5. actionMap — ${affordances.length} perceivable affordances (perception only; never an action API)`);
for (const entry of affordances.slice(0, 5)) {
  const box = `${entry.rect.x.toFixed(2)},${entry.rect.y.toFixed(2)}`;
  console.log(`   ${pad(entry.ref, 16)}${pad(entry.role, 10)}${pad(entry.name ?? "", 26)}@ ${box} (${entry.state.visibility})`);
}
console.log(`   … ${Math.max(0, affordances.length - 5)} more`);
console.log("");

// --- 6. Every ref in a view resolves back to its evidence --------------------

const cta = snapshot.nodes.find((n) => n.elementRef === ctaRef);
const resolution = resolveElementRefInSnapshot(
  snapshot,
  { snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash },
  ctaRef,
);
console.log("6. Compression with receipts — the view is lean, the provenance is not lost");
console.log(`   ${ctaRef} resolves in this snapshot: ${resolution.ok}`);
console.log(`   evidence claims on that node: ${cta.evidence.length}`);
for (const claim of cta.evidence) {
  console.log(`     ${pad(claim.sourceType, 16)}conf ${claim.confidence}   ${claim.claims.join(", ")}`);
}
console.log(`   flags: ${cta.flags.join(", ") || "none"}`);
const foreign = resolveElementRefInSnapshot(
  snapshot,
  { snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash },
  "ug:00000000:9999",
);
console.log(`   a ref from another snapshot is refused: ${foreign.ok === false ? foreign.reason : "RESOLVED (unexpected)"}`);
console.log("");

// --- 7. Pixel escalation is a recommendation, not a fetch --------------------

const patchContext = views.get("patchContext");
console.log(`7. patchContext requested ${patchContext.evidenceRequests.length} crop(s) — recommendations the caller may decline`);
for (const request of patchContext.evidenceRequests) {
  const r = request.rect;
  console.log(`   ${request.kind} of ${request.sourceArtifactRef}`);
  console.log(`     rect ${r.x},${r.y} ${r.width}x${r.height}  refs ${request.elementRefs.join(", ")}  because ${request.reason}`);
}
console.log("");

// --- 8. Write the artifacts --------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}capture.json`, `${JSON.stringify(capture, null, 2)}\n`);
writeFileSync(`${OUT_DIR}snapshot.json`, `${JSON.stringify(snapshot, null, 2)}\n`);
for (const [name, view] of views) {
  writeFileSync(`${OUT_DIR}view-${name}.json`, `${JSON.stringify(view, null, 2)}\n`);
}

console.log("8. Wrote out/capture.json, out/snapshot.json and 5 out/view-*.json files.");
console.log("");
console.log(`OK — built snapshot ${snapshot.snapshotId.slice(0, 20)}… and rendered 5 schema-valid views.`);
