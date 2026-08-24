/**
 * `--screenshot` end to end, without a browser.
 *
 * The flag used to write a `file://<absolute path>` artifact ref into the
 * capture bundle. Nothing rejected it at capture time, so the run looked healthy
 * all the way through `buildUiGraph`, and then every `patchContext` view failed
 * the normative view schema on
 * `evidenceRequests[0].sourceArtifactRef must match "^artifact://…"`. The CLI
 * exited 1 having written `capture.json` and `screenshot.png` and neither
 * `snapshot.json` nor any `view-*.json`.
 *
 * A fake `CapturablePage` over the recorded CDP session lets these assertions
 * run in `pnpm test`, with no browser binary, right through to schema
 * validation of the view a user is actually promised.
 */

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildUiGraph,
  queryUiGraph,
  validateView,
  type CaptureBundleReadProfile,
  type UIGraphViewSpec,
} from "@apatureai/lattice";
import { captureFromPage, screenshotArtifactRef } from "../src/index.js";
import type { CapturablePage } from "../src/index.js";
import type { CdpAxNode, CdpDomSnapshot, CdpSessionLike } from "../src/index.js";

/** The pattern `schemas/ui-graph-view.schema.json` puts on `sourceArtifactRef`. */
const VIEW_SCHEMA_ARTIFACT_REF = /^artifact:\/\/[A-Za-z0-9._:/-]+$/;

interface Recording {
  domSnapshot: CdpDomSnapshot;
  axNodes: CdpAxNode[];
  page: {
    url: string;
    route: string;
    viewportWidthCssPx: number;
    viewportHeightCssPx: number;
    deviceScaleFactor: number;
    scrollXCssPx: number;
    scrollYCssPx: number;
  };
}

const recording = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/cdp-recording.json", import.meta.url)), "utf8"),
) as Recording;

const FRAME_IDS = [...new Set(recording.axNodes.map((n) => n.frameId!))];

const session: CdpSessionLike = {
  async send(method, params) {
    switch (method) {
      case "DOMSnapshot.enable":
      case "Accessibility.enable":
      case "Page.enable":
      case "DOM.enable":
      case "Animation.enable":
      case "Animation.setPlaybackRate":
        return {};
      case "DOMSnapshot.captureSnapshot":
        return recording.domSnapshot;
      case "Page.getFrameTree":
        return {
          frameTree: {
            frame: { id: FRAME_IDS[0] },
            childFrames: FRAME_IDS.slice(1).map((id) => ({ frame: { id } })),
          },
        };
      case "Accessibility.getFullAXTree": {
        const frameId = (params as { frameId?: string } | undefined)?.frameId;
        if (frameId === undefined) return { nodes: recording.axNodes };
        return { nodes: recording.axNodes.filter((n) => n.frameId === frameId) };
      }
      default:
        throw new Error(`unexpected CDP call ${method}`);
    }
  },
};

/** A page that answers the four calls `captureFromPage` makes, and no more. */
function fakePage(): { page: CapturablePage; screenshots: string[] } {
  const screenshots: string[] = [];
  const page: CapturablePage = {
    url: () => recording.page.url,
    async evaluate() {
      return {
        scrollX: recording.page.scrollXCssPx,
        scrollY: recording.page.scrollYCssPx,
        dpr: recording.page.deviceScaleFactor,
        vw: recording.page.viewportWidthCssPx,
        vh: recording.page.viewportHeightCssPx,
      };
    },
    async screenshot({ path }) {
      screenshots.push(path);
      // Stand-in for real PNG bytes; only its existence and path are asserted.
      writeFileSync(path, Buffer.from("89504e470d0a1a0a", "hex"));
      return undefined;
    },
    context: () => ({ async newCDPSession() { return session; } }),
  };
  return { page, screenshots };
}

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

function specFor(kind: UIGraphViewSpec["kind"], extra: Partial<UIGraphViewSpec>): UIGraphViewSpec {
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

async function captureWithScreenshot(dir: string): Promise<CaptureBundleReadProfile> {
  const { page } = fakePage();
  return captureFromPage(page, { screenshotPath: join(dir, "screenshot.png"), stabilityProbeMs: 0 });
}

describe("screenshot evidence", () => {
  it("writes the file the caller asked for and references it with a logical artifact ref", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lattice-shot-"));
    const capture = await captureWithScreenshot(dir);

    expect(existsSync(join(dir, "screenshot.png"))).toBe(true);
    expect(statSync(join(dir, "screenshot.png")).size).toBeGreaterThan(0);

    const evidence = capture.screenshotEvidence?.[0];
    expect(evidence).toBeDefined();
    // The regression: this used to be `file:///…/screenshot.png`.
    expect(evidence!.artifactRef).toMatch(VIEW_SCHEMA_ARTIFACT_REF);
    expect(evidence!.artifactRef).not.toContain(dir);
    expect(evidence!.widthImagePx).toBe(recording.page.viewportWidthCssPx * recording.page.deviceScaleFactor);

    // Pixels stay outside the graph: the bundle carries a pointer, not bytes.
    expect(JSON.stringify(capture)).not.toContain("data:image");
  });

  it("plans an evidence request whose view passes the normative schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lattice-shot-"));
    const capture = await captureWithScreenshot(dir);
    const { snapshot } = await buildUiGraph({ capture, options: { ...BUILD_OPTIONS } });

    const actionMap = queryUiGraph({ snapshot, spec: specFor("actionMap", {}) });
    const first = (JSON.parse(actionMap.text) as { actions: Array<{ ref: string }> }).actions[0];
    expect(first).toBeDefined();

    const ref = capture.screenshotEvidence![0]!.artifactRef;
    const view = queryUiGraph({
      snapshot,
      spec: specFor("patchContext", { refs: [first!.ref], maxCrops: 2 }),
      screenshotArtifactRef: ref,
    });

    // This is the assertion the old suite never made, and the exact one that
    // failed for every real `--screenshot` run.
    const check = validateView(view);
    expect(check.valid).toBe(true);
    expect(view.evidenceRequests.length).toBeGreaterThan(0);
    expect(view.evidenceRequests[0]!.sourceArtifactRef).toBe(ref);
  });

  it("keeps the capture byte-identical no matter where the screenshot is written", async () => {
    const a = await captureWithScreenshot(mkdtempSync(join(tmpdir(), "lattice-shot-a-")));
    const b = await captureWithScreenshot(mkdtempSync(join(tmpdir(), "lattice-shot-b-")));

    // A machine-specific absolute path in the bundle would break this, which is
    // the property the capture adapter exists to provide.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("mints a ref inside the schema charset even from an awkward capture id", () => {
    const ref = screenshotArtifactRef("cap_a b/c?d#e", "frame 0");
    expect(ref).toMatch(VIEW_SCHEMA_ARTIFACT_REF);
    expect(ref).toBe("artifact://capture/cap_a-b-c-d-e/frame-0/screenshot.png");
    expect(screenshotArtifactRef("///", "???")).toMatch(VIEW_SCHEMA_ARTIFACT_REF);
  });

  it("refuses a screenshot ref that could never appear in a valid view", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lattice-shot-"));
    const capture = await captureWithScreenshot(dir);
    const { snapshot } = await buildUiGraph({ capture, options: { ...BUILD_OPTIONS } });
    const actionMap = queryUiGraph({ snapshot, spec: specFor("actionMap", {}) });
    const first = (JSON.parse(actionMap.text) as { actions: Array<{ ref: string }> }).actions[0]!;

    const query = (screenshotArtifactRefValue: string): unknown =>
      queryUiGraph({
        snapshot,
        spec: specFor("patchContext", { refs: [first.ref], maxCrops: 2 }),
        screenshotArtifactRef: screenshotArtifactRefValue,
      });

    // One clear error at the boundary beats a view that reports a budget, a
    // truncation flag and no warning, then fails its own published schema.
    let thrown: unknown;
    try {
      query(`file://${join(dir, "screenshot.png")}`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const issues = (thrown as { issues?: Array<{ code: string; message: string }> }).issues ?? [];
    expect(issues.map((i) => i.code)).toContain("malformed_screenshot_artifact_ref");
    expect(issues.find((i) => i.code === "malformed_screenshot_artifact_ref")!.message).toContain(
      "not a logical artifact ref",
    );

    expect(() => query("artifact://capture/cap_x/frame_0/screenshot.png")).not.toThrow();
  });
});
