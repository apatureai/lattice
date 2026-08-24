/**
 * The live suite: a real Chromium, a real page, a real scene graph.
 *
 * These tests need the browser binary, so they are NOT part of `pnpm test`. Run
 * them with:
 *
 *   pnpm exec playwright-core install chromium
 *   pnpm test:browser
 *
 * They deliberately load a `file://` fixture rather than a site: no network, no
 * flake from someone else's uptime, and the assertions can be exact.
 *
 * Everything that can be checked without a browser is checked in `test/`. What
 * is left here is what only a real browser can prove: that the protocol calls
 * this adapter makes are the calls Chromium actually answers, and that two
 * separate browser sessions over the same page seal to the same snapshot.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildUiGraph,
  canonicalize,
  queryUiGraph,
  validateCaptureBundle,
  validateView,
  type CaptureBundleReadProfile,
} from "@apatureai/lattice";
import { captureUrl } from "../src/index.js";

const PAGE_URL = `file://${fileURLToPath(new URL("../test/fixtures/page.html", import.meta.url))}`;
const TIMEOUT = 120_000;

const BUILD_OPTIONS = {
  builderVersion: "ui-graph-builder@0.1.0",
  schemaVersion: "1.0.0",
  relationPolicyVersion: "relations@1",
  dnaProjectionVersion: "dna-projection@1",
  redactionPolicyVersion: "capture-selector-redaction@1",
  useMode: "offline_eval",
  maxNodes: 2000,
  maxPersistedEdgesPerNode: 8,
  repeatedRegionThreshold: 3,
  textPolicy: "truncate",
  includeHiddenExplanatoryNodes: false,
} as const;

async function graphOf(capture: CaptureBundleReadProfile) {
  const { snapshot } = await buildUiGraph({ capture, options: { ...BUILD_OPTIONS } });
  return snapshot;
}

describe("captureUrl against a real page", () => {
  it(
    "turns a URL into a capture lattice accepts",
    async () => {
      const capture = await captureUrl(PAGE_URL, {
        repository: { owner: "apatureai", name: "lattice" },
        route: "/deployments",
      });

      expect(validateCaptureBundle(capture).ok).toBe(true);
      expect(capture.route).toBe("/deployments");
      expect(capture.viewport.widthCssPx).toBe(1440);
      expect(capture.pageHealth.stable).toBe(true);
      expect(capture.pageHealth.partial).toBe(false);

      const main = capture.documents[0]!;
      expect(main.domLayoutNodes.length).toBeGreaterThan(50);
      expect(main.accessibilityNodes.length).toBeGreaterThan(50);
      expect((main.textRuns ?? []).length).toBeGreaterThan(30);
      expect(main.domLayoutNodes.filter((n) => n.attributes?.["data-testid"] !== undefined).length)
        .toBeGreaterThan(5);

      // The iframe's document, with the semantics only a per-frame accessibility
      // call returns.
      expect(capture.documents).toHaveLength(2);
      expect(capture.documents[1]!.parentFrameId).toBe("frame_0");
      expect(capture.documents[1]!.accessibilityNodes.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    "seals to the same snapshot from two separate browser sessions",
    async () => {
      const first = await captureUrl(PAGE_URL, { repository: { owner: "apatureai", name: "lattice" } });
      const second = await captureUrl(PAGE_URL, { repository: { owner: "apatureai", name: "lattice" } });

      expect(canonicalize(second)).toBe(canonicalize(first));
      const [a, b] = await Promise.all([graphOf(first), graphOf(second)]);
      expect(b.contentHash).toBe(a.contentHash);
    },
    TIMEOUT,
  );

  it(
    "answers bounded questions about the page it just captured",
    async () => {
      const capture = await captureUrl(PAGE_URL);
      const snapshot = await graphOf(capture);

      const view = queryUiGraph({
        snapshot,
        spec: {
          kind: "actionMap",
          maxTextTokens: 100_000,
          maxNodes: 400,
          maxEdges: 400,
          maxCrops: 0,
          includeSensitive: false,
          tokenizerProfile: "char-quarter-estimate@1",
          rendererVersion: "ui-graph-renderer@0.2.0",
        },
      });
      expect(validateView(view).valid).toBe(true);

      const actions = (JSON.parse(view.text) as {
        actions: Array<{ name?: string; role: string; state: { visibility: string } }>;
      }).actions;
      // The call to action: DOM said `a`, the role attribute and the
      // accessibility tree both said button, and it is above the fold.
      expect(actions.some((a) => a.name === "New review" && a.role === "button")).toBe(true);
      // A form field far below the fold is still an affordance, and the view says
      // so rather than pretending it is on screen.
      const cardField = actions.find((a) => a.name === "Card number");
      expect(cardField?.role).toBe("textbox");
      expect(cardField?.state.visibility).not.toBe("visible");

      const captureBytes = Buffer.byteLength(canonicalize(capture), "utf8");
      expect(view.budget.serializedBytes).toBeLessThan(captureBytes);
    },
    TIMEOUT,
  );

  it(
    "redacts a subtree at the producer, so the text never reaches the graph",
    async () => {
      const capture = await captureUrl(PAGE_URL, {
        redactSelectors: ['[data-testid="billing-contact"]'],
      });

      expect(capture.redaction.applied).toBe(true);
      expect(capture.redaction.redactedSourceIds.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(capture)).not.toContain("billing@example.invalid");

      const snapshot = await graphOf(capture);
      expect(JSON.stringify(snapshot)).not.toContain("billing@example.invalid");
      expect(snapshot.nodes.some((n) => n.sensitivity.includes("redacted"))).toBe(true);

      // And the renderer withholds it again on the way into a prompt.
      const summary = queryUiGraph({
        snapshot,
        spec: {
          kind: "summary",
          maxTextTokens: 100_000,
          maxNodes: 400,
          maxEdges: 400,
          maxCrops: 0,
          includeSensitive: false,
          tokenizerProfile: "char-quarter-estimate@1",
          rendererVersion: "ui-graph-renderer@0.2.0",
        },
      });
      expect(summary.text).toContain("withheld:sensitive");
      expect(summary.text).not.toContain("billing@example.invalid");
    },
    TIMEOUT,
  );

  it(
    "records scroll position without moving the document-space geometry",
    async () => {
      const top = await captureUrl(PAGE_URL);
      const scrolled = await captureUrl(PAGE_URL, { scrollTo: { x: 0, y: 200 } });

      expect(top.viewport.scrollYCssPx).toBe(0);
      expect(scrolled.viewport.scrollYCssPx).toBe(200);

      const boundsOf = (capture: CaptureBundleReadProfile) =>
        capture.documents[0]!.domLayoutNodes.find((n) => n.attributes?.["data-testid"] === "new-review")!.bounds;
      expect(boundsOf(scrolled)).toEqual(boundsOf(top));
    },
    TIMEOUT,
  );

  it(
    "writes a screenshot and references it as evidence, by ref, never by bytes",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "lattice-capture-"));
      const capture = await captureUrl(PAGE_URL, { screenshotPath: join(dir, "shot.png") });

      const evidence = capture.screenshotEvidence?.[0];
      expect(evidence).toBeDefined();
      // Not `file://<abs path>`: that ref is machine-specific and the normative
      // view schema refuses it, so it broke every `--screenshot` run.
      expect(evidence!.artifactRef).toMatch(/^artifact:\/\/[A-Za-z0-9._:/-]+$/);
      expect(evidence!.artifactRef).not.toContain(dir);
      // The ref is minted from `captureId`, which is derived from the page URL,
      // so checking it against the screenshot's output directory checked the
      // wrong path: the machine was arriving through the page's own directory.
      // This page is a `file:` URL, so pin the whole ref.
      expect(evidence!.artifactRef).toBe("artifact://capture/cap_page.html/frame_0/screenshot.png");
      expect(capture.route).toBe("/page.html");
      expect(capture.documents[0]!.url).toBe("file:///page.html");
      expect(JSON.stringify(capture)).not.toContain(dirname(fileURLToPath(PAGE_URL)));
      expect(evidence!.widthImagePx).toBe(1440);
      expect(readdirSync(dir)).toContain("shot.png");
      expect(statSync(join(dir, "shot.png")).size).toBeGreaterThan(1000);

      // Pixels stay outside the graph: the bundle carries a pointer, not bytes.
      expect(JSON.stringify(capture)).not.toContain("data:image");
    },
    TIMEOUT,
  );

  it(
    "delivers every artifact `pnpm capture --screenshot` promises, and exits 0",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "lattice-cli-"));
      const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
      if (!existsSync(cli)) throw new Error(`run \`pnpm build\` first: ${cli} does not exist`);

      const run = spawnSync(process.execPath, [cli, PAGE_URL, "--out", dir, "--screenshot"], {
        encoding: "utf8",
        timeout: TIMEOUT,
      });

      // The flag used to exit 1 here, after writing capture.json and the png and
      // nothing else, on `sourceArtifactRef must match "^artifact://…"`.
      expect(`${run.stdout}${run.stderr}`).not.toContain("lattice-capture failed");
      expect(run.status).toBe(0);

      const written = readdirSync(dir);
      expect(written).toContain("capture.json");
      expect(written).toContain("screenshot.png");
      expect(written).toContain("snapshot.json");
      expect(written.filter((f) => f.startsWith("view-") && f.endsWith(".json")).length)
        .toBeGreaterThanOrEqual(4);
      // patchContext is the view that carries the evidence request, so it is the
      // one the broken ref took down.
      expect(written).toContain("view-patchContext.json");

      const view = JSON.parse(readFileSync(join(dir, "view-patchContext.json"), "utf8")) as {
        evidenceRequests: Array<{ sourceArtifactRef: string }>;
      };
      expect(validateView(view as never).valid).toBe(true);
      expect(view.evidenceRequests.length).toBeGreaterThan(0);
      expect(view.evidenceRequests[0]!.sourceArtifactRef).toBe(
        JSON.parse(readFileSync(join(dir, "capture.json"), "utf8")).screenshotEvidence[0].artifactRef,
      );
    },
    TIMEOUT,
  );

  it(
    "reports a partial capture instead of quietly dropping the rest of the page",
    async () => {
      const capture = await captureUrl(PAGE_URL, { maxNodes: 10 });
      expect(capture.documents[0]!.domLayoutNodes).toHaveLength(10);
      expect(capture.pageHealth.partial).toBe(true);
      expect(capture.pageHealth.reasons).toContain("node_budget_exhausted");
    },
    TIMEOUT,
  );
});
