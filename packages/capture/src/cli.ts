#!/usr/bin/env node
/**
 * `lattice-capture <url>`: a real page in, a queryable scene graph out.
 *
 * This is the path the README leads with. It opens the URL in headless
 * Chromium, captures DOM/layout, computed style, text boxes and the
 * accessibility tree over CDP, fuses them into one sealed content-addressed
 * snapshot, renders the bounded views, and writes every artifact to disk so the
 * numbers it prints can be checked against the files it produced.
 *
 * Everything it prints is derived from the snapshot it just built. There is no
 * canned output.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildUiGraph,
  canonicalize,
  formatErrors,
  queryUiGraph,
  UIGraphError,
  validateView,
  type AnyUIDNAReadProfile,
  type CaptureBundleReadProfile,
  type UIGraphView,
  type UIGraphViewSpec,
} from "@apature/ui-graph";
import { captureUrl, type CaptureUrlOptions } from "./browser.js";

const USAGE = `lattice-capture <url> [options]

  --out <dir>           where to write artifacts (default ./out)
  --viewport <WxH>      viewport in CSS pixels (default 1440x900)
  --dsf <n>             device scale factor (default 1)
  --wait-for <selector> wait for this selector before capturing
  --settle <ms>         quiet time after load and fonts (default 300)
  --scroll-to <X,Y>     scroll to this offset before capturing
  --redact <selector>   redact this subtree at the producer; repeatable
  --repo <owner/name>   repository recorded on the capture
  --route <path>        route recorded on the capture (default the URL path)
  --max-nodes <n>       DOM node cap; exceeding it marks the capture partial (default 4000)
  --dna <file>          a UI-DNA graph projection to match against, enabling the violations view
  --screenshot          also save a viewport screenshot and reference it
  --dark                emulate prefers-color-scheme: dark
  --headed              run with a visible browser window
  --capture-only        stop after the capture bundle; do not build a graph
  --json                print the capture bundle to stdout and write nothing
  -h, --help            show this message

Needs a browser once:  pnpm browser:install
                       (that is: pnpm exec playwright-core install chromium)`;

/** One entry of an `actionMap` view, as that renderer emits it. */
interface Affordance {
  ref: string;
  role: string;
  name?: string;
  rect: { x: number; y: number };
  state: { visibility: string };
}

interface Args {
  url: string;
  out: string;
  json: boolean;
  captureOnly: boolean;
  screenshot: boolean;
  dnaPath: string | undefined;
  options: CaptureUrlOptions;
}

function parseArgs(argv: readonly string[]): Args | null {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) return null;

  let url: string | undefined;
  let out = "out";
  let json = false;
  let captureOnly = false;
  let screenshot = false;
  let dnaPath: string | undefined;
  const redact: string[] = [];
  const options: Record<string, unknown> = {};

  const next = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--out": out = next(i, arg); i += 1; break;
      case "--viewport": {
        const raw = next(i, arg);
        const match = /^(\d+)x(\d+)$/.exec(raw);
        if (match === null) throw new Error(`--viewport expects WxH, got "${raw}"`);
        options["viewport"] = { width: Number(match[1]), height: Number(match[2]) };
        i += 1;
        break;
      }
      case "--dsf": {
        const dsf = Number(next(i, arg));
        const viewport = (options["viewport"] as { width: number; height: number } | undefined) ?? {
          width: 1440,
          height: 900,
        };
        options["viewport"] = { ...viewport, deviceScaleFactor: dsf };
        i += 1;
        break;
      }
      case "--wait-for": options["waitForSelector"] = next(i, arg); i += 1; break;
      case "--settle": options["settleMs"] = Number(next(i, arg)); i += 1; break;
      case "--scroll-to": {
        const raw = next(i, arg);
        const match = /^(-?\d+),(-?\d+)$/.exec(raw);
        if (match === null) throw new Error(`--scroll-to expects X,Y, got "${raw}"`);
        options["scrollTo"] = { x: Number(match[1]), y: Number(match[2]) };
        i += 1;
        break;
      }
      case "--redact": redact.push(next(i, arg)); i += 1; break;
      case "--repo": {
        const raw = next(i, arg);
        const [owner, name] = raw.split("/");
        if (owner === undefined || name === undefined || name === "") {
          throw new Error(`--repo expects owner/name, got "${raw}"`);
        }
        options["repository"] = { owner, name };
        i += 1;
        break;
      }
      case "--route": options["route"] = next(i, arg); i += 1; break;
      case "--max-nodes": options["maxNodes"] = Number(next(i, arg)); i += 1; break;
      case "--dna": dnaPath = next(i, arg); i += 1; break;
      case "--screenshot": screenshot = true; break;
      case "--dark": options["colorScheme"] = "dark"; break;
      case "--headed": options["headed"] = true; break;
      case "--capture-only": captureOnly = true; break;
      case "--json": json = true; break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option "${arg}"`);
        if (url !== undefined) throw new Error(`unexpected second url "${arg}"`);
        url = arg;
    }
  }

  if (url === undefined) throw new Error("a url is required");
  if (redact.length > 0) options["redactSelectors"] = redact;
  return { url, out, json, captureOnly, screenshot, dnaPath, options: options as CaptureUrlOptions };
}

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const tokens = (value: string): number => Math.ceil(value.length / 4);
const pct = (part: number, whole: number): string => `${(100 * (1 - part / whole)).toFixed(1)}%`;
const pad = (value: unknown, width: number): string => String(value).padEnd(width);
const padLeft = (value: unknown, width: number): string => String(value).padStart(width);

function specFor(kind: UIGraphViewSpec["kind"], extra: Partial<UIGraphViewSpec> = {}): UIGraphViewSpec {
  return {
    kind,
    maxTextTokens: 100_000,
    maxNodes: 400,
    maxEdges: 400,
    maxCrops: 0,
    includeSensitive: false,
    tokenizerProfile: "char-quarter-estimate@1",
    rendererVersion: "ui-graph-renderer@0.2.0",
    ...extra,
  } as UIGraphViewSpec;
}

function reportCapture(capture: CaptureBundleReadProfile, captureJson: string): void {
  const domNodes = capture.documents.reduce((n, d) => n + d.domLayoutNodes.length, 0);
  const axNodes = capture.documents.reduce((n, d) => n + d.accessibilityNodes.length, 0);
  const textRuns = capture.documents.reduce((n, d) => n + (d.textRuns?.length ?? 0), 0);
  const joined = capture.documents.reduce(
    (n, d) => n + d.accessibilityNodes.filter((a) => a.backendDomSourceId !== undefined).length,
    0,
  );

  console.log("1. Capture (headless Chromium, DOMSnapshot + full accessibility tree over CDP)");
  console.log(`   route              ${capture.route}  @ ${capture.viewport.widthCssPx}x${capture.viewport.heightCssPx} css px, dsf ${capture.viewport.deviceScaleFactor}`);
  console.log(`   frames             ${capture.documents.length}`);
  console.log(`   dom/layout nodes   ${domNodes}`);
  console.log(`   accessibility      ${axNodes}  (${joined} joined to a DOM node by backend id)`);
  console.log(`   text runs          ${textRuns}`);
  console.log(`   page health        stable=${capture.pageHealth.stable} partial=${capture.pageHealth.partial}${capture.pageHealth.reasons.length > 0 ? `  (${capture.pageHealth.reasons.join(", ")})` : ""}`);
  console.log(`   redaction          applied=${capture.redaction.applied}  ${capture.redaction.redactedSourceIds.length} source id(s)`);
  console.log(`   canonical JSON     ${bytes(captureJson)} bytes (${tokens(captureJson)} est. tokens)`);
  const shot = capture.screenshotEvidence?.[0];
  if (shot !== undefined) {
    console.log(`   screenshot         ${shot.widthImagePx}x${shot.heightImagePx} image px, referenced as ${shot.artifactRef}`);
  }
  console.log("");
}

async function main(): Promise<number> {
  let args: Args | null;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`lattice-capture: ${(error as Error).message}\n`);
    console.error(USAGE);
    return 2;
  }
  if (args === null) {
    console.log(USAGE);
    return 0;
  }

  const outDir = resolve(args.out);
  if (!args.json) mkdirSync(outDir, { recursive: true });

  const capture = await captureUrl(args.url, {
    ...args.options,
    ...(args.screenshot && !args.json ? { screenshotPath: join(outDir, "screenshot.png") } : {}),
  });

  if (args.json) {
    console.log(JSON.stringify(capture, null, 2));
    return 0;
  }

  const captureJson = canonicalize(capture);
  writeFileSync(join(outDir, "capture.json"), `${JSON.stringify(capture, null, 2)}\n`);
  reportCapture(capture, captureJson);

  if (args.captureOnly) {
    console.log(`OK, wrote ${join(args.out, "capture.json")}. Feed it to buildUiGraph when you are ready.`);
    return 0;
  }

  const dna =
    args.dnaPath === undefined
      ? undefined
      : (JSON.parse(readFileSync(resolve(args.dnaPath), "utf8")) as AnyUIDNAReadProfile);

  const { snapshot, diagnostics } = await buildUiGraph({
    capture,
    ...(dna === undefined ? {} : { dna }),
    options: {
      builderVersion: "ui-graph-builder@0.1.0",
      schemaVersion: "1.0.0",
      relationPolicyVersion: "relations@1",
      dnaProjectionVersion: "dna-projection@1",
      redactionPolicyVersion: capture.redaction.policyVersion,
      useMode: "offline_eval",
      maxNodes: 2000,
      maxPersistedEdgesPerNode: 8,
      repeatedRegionThreshold: 3,
      textPolicy: "truncate",
      includeHiddenExplanatoryNodes: false,
    },
  });

  console.log("2. buildUiGraph: fuse, hierarchy, relations, seal");
  console.log(`   snapshotId         ${snapshot.snapshotId}`);
  console.log(`   contentHash        ${snapshot.contentHash}`);
  console.log(`   nodes / edges      ${snapshot.metrics.graph.nodes} / ${snapshot.metrics.graph.edges}`);
  console.log(`   regions            ${snapshot.metrics.graph.regions}`);
  console.log(`   retained conflicts ${snapshot.metrics.graph.conflictCount}   (sources that disagreed; both claims kept)`);
  console.log(`   canonical JSON     ${diagnostics.canonicalJsonBytes} bytes`);
  console.log("");

  const screenshotArtifactRef = capture.screenshotEvidence?.[0]?.artifactRef;
  const actionMapView = queryUiGraph({ snapshot, spec: specFor("actionMap") });
  const affordances = (JSON.parse(actionMapView.text) as { actions: Affordance[] }).actions;
  const firstRef = affordances[0]?.ref;

  const queries: Array<[string, UIGraphViewSpec]> = [
    ["summary", specFor("summary")],
    ["actionMap", specFor("actionMap")],
  ];
  // Without a design-system projection there is nothing to conform to, so the
  // violations view would be an empty answer to a question nobody asked.
  if (dna !== undefined) queries.push(["violations", specFor("violations")]);
  if (firstRef !== undefined) {
    queries.push(["focus", specFor("focus", { refs: [firstRef] })]);
    queries.push(["patchContext", specFor("patchContext", { refs: [firstRef], maxCrops: 2 })]);
  }

  console.log(
    `3. queryUiGraph: ${queries.length} views of the same snapshot` +
      (firstRef === undefined ? " (no affordance found, so no focus/patchContext)" : ` (focus/patchContext on ${firstRef})`),
  );
  console.log(`   ${pad("view", 14)}${padLeft("bytes", 8)}${padLeft("est.tok", 9)}${padLeft("nodes", 7)}${padLeft("vs capture", 12)}  truncation`);

  const views = new Map<string, UIGraphView>();
  for (const [name, spec] of queries) {
    const view = queryUiGraph({
      snapshot,
      spec,
      ...(screenshotArtifactRef === undefined ? {} : { screenshotArtifactRef }),
    });
    const check = validateView(view);
    if (!check.valid) throw new Error(`${name} view failed schema validation: ${formatErrors(check.errors)}`);
    views.set(name, view);
    const reason = view.truncation.truncated ? view.truncation.reasons[0] : "none";
    console.log(
      `   ${pad(name, 14)}${padLeft(view.budget.serializedBytes, 8)}${padLeft(view.budget.estimatedTextTokens, 9)}` +
        `${padLeft(view.budget.includedNodes, 7)}${padLeft(pct(view.budget.serializedBytes, bytes(captureJson)), 12)}  ${reason}`,
    );
  }
  console.log('   ("vs capture" is the reduction against the canonical capture JSON above.)');
  console.log("");

  console.log(`4. actionMap: ${affordances.length} perceivable affordances (perception only; never an action API)`);
  for (const entry of affordances.slice(0, 5)) {
    const box = `${entry.rect.x.toFixed(2)},${entry.rect.y.toFixed(2)}`;
    console.log(`   ${pad(entry.ref, 16)}${pad(entry.role, 10)}${pad((entry.name ?? "").slice(0, 24), 26)}@ ${box} (${entry.state.visibility})`);
  }
  if (affordances.length > 5) console.log(`   … ${affordances.length - 5} more`);
  console.log("");

  writeFileSync(join(outDir, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  for (const [name, view] of views) {
    writeFileSync(join(outDir, `view-${name}.json`), `${JSON.stringify(view, null, 2)}\n`);
  }

  const wroteScreenshot = args.screenshot ? `, ${args.out}/screenshot.png` : "";
  console.log(
    `5. Wrote ${args.out}/capture.json, ${args.out}/snapshot.json${wroteScreenshot} and ${views.size} ${args.out}/view-*.json files.`,
  );
  console.log("");
  console.log(`OK, captured ${args.url} and built snapshot ${snapshot.snapshotId.slice(0, 20)}… with ${views.size} schema-valid views.`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UIGraphError) {
      // A build failure carries typed, path-anchored issues (e.g. why a --dna
      // profile was rejected). Print them, not just the top-line message, so the
      // producer can see exactly what to fix.
      console.error(`lattice-capture failed: ${error.message} (${error.code})`);
      for (const issue of error.issues) {
        console.error(`  - [${issue.code}] ${issue.message}`);
      }
      if (error.code === "invalid_dna") {
        console.error(
          "\nA UI-DNA profile needs projectionSchemaVersion with major \"1\" (e.g. \"1.0.0\"),\n" +
            "state \"approved\" (or useMode \"offline_eval\"/\"shadow\" for experimental),\n" +
            "and tokens categorised color/typography/radii/spacing.\n" +
            "See examples/design-dna.json and the README \"Bring your own design system\" section.",
        );
      }
    } else {
      console.error(`lattice-capture failed: ${(error as Error).message}`);
    }
    process.exitCode = 1;
  },
);
