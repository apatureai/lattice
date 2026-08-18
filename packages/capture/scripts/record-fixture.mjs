#!/usr/bin/env node
/**
 * Re-record the frozen CDP payload the pure-transform golden test runs against.
 *
 * Run from the repo root, after `pnpm build`:
 *
 *   node packages/capture/scripts/record-fixture.mjs
 *
 * It opens `test/fixtures/page.html` in headless Chromium, dumps exactly the two
 * protocol payloads and the page facts that `captureBundleFromCdp` consumes, and
 * writes them to `test/fixtures/cdp-recording.json`. The golden test then
 * exercises the whole adapter with no browser at all, which is what lets the
 * default test suite stay hermetic.
 *
 * Re-record when the fixture page changes or when a Chromium upgrade changes the
 * protocol output, and read the diff: it is the honest record of what the browser
 * now reports.
 *
 * What Chromium reports includes the absolute path of whichever checkout ran the
 * recording, in `documentURL`, in the string table and in an accessibility node's
 * `url` property. That path names a machine and usually an account, and it would
 * land in a committed fixture. Every `file:` URL in the payload is therefore
 * reduced by the adapter's own `locationIndependentUrl` before the file is
 * written, which is the same reduction a live capture applies, so re-recording
 * on any machine produces the same neutral URLs rather than that machine's.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { REQUESTED_COMPUTED_STYLES } from "../dist/style.js";
import { locationIndependentUrl } from "../dist/transform.js";

const PAGE = fileURLToPath(new URL("../test/fixtures/page.html", import.meta.url));
const OUT = fileURLToPath(new URL("../test/fixtures/cdp-recording.json", import.meta.url));

/** Every `file:` URL anywhere in the recorded payload, reduced to its file name. */
function neutralizeFileUrls(value) {
  if (typeof value === "string") {
    return value.startsWith("file://") ? locationIndependentUrl(value) : value;
  }
  if (Array.isArray(value)) return value.map(neutralizeFileUrls);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, neutralizeFileUrls(v)]));
  }
  return value;
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`file://${PAGE}`, { waitUntil: "load", timeout: 30_000 });
  await page.evaluate("document.fonts ? document.fonts.ready.then(() => null) : null");

  const session = await context.newCDPSession(page);
  await session.send("DOMSnapshot.enable");
  await session.send("Accessibility.enable");
  await session.send("Page.enable");

  const domSnapshot = await session.send("DOMSnapshot.captureSnapshot", {
    computedStyles: [...REQUESTED_COMPUTED_STYLES],
    includePaintOrder: true,
    includeDOMRects: false,
  });

  const { frameTree } = await session.send("Page.getFrameTree");
  const frames = [];
  const walk = (node) => {
    frames.push(node.frame.id);
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(frameTree);

  const axNodes = [];
  for (const [index, frameId] of frames.entries()) {
    const tree = await session.send("Accessibility.getFullAXTree", { frameId });
    for (const node of tree.nodes ?? []) {
      axNodes.push({
        ...node,
        nodeId: `${index}_${node.nodeId}`,
        ...(node.parentId === undefined ? {} : { parentId: `${index}_${node.parentId}` }),
        frameId,
      });
    }
  }

  const metrics = await page.evaluate(`({
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    dpr: window.devicePixelRatio,
    vw: document.documentElement.clientWidth,
    vh: document.documentElement.clientHeight
  })`);

  writeFileSync(
    OUT,
    `${JSON.stringify(
      neutralizeFileUrls({
        recordedFrom: "packages/capture/test/fixtures/page.html",
        domSnapshot,
        axNodes,
        page: {
          url: locationIndependentUrl(`file://${PAGE}`),
          route: new URL(locationIndependentUrl(`file://${PAGE}`)).pathname,
          viewportWidthCssPx: metrics.vw,
          viewportHeightCssPx: metrics.vh,
          deviceScaleFactor: metrics.dpr,
          scrollXCssPx: metrics.scrollX,
          scrollYCssPx: metrics.scrollY,
        },
      }),
      null,
      1,
    )}\n`,
  );
  console.log(`Wrote ${OUT}`);
} finally {
  await browser.close();
}
