/**
 * The only module that knows a browser library exists.
 *
 * `playwright-core` is an OPTIONAL peer dependency and is loaded through a
 * dynamic `import()`, so importing `@apatureai/lattice-capture` for its types or
 * its pure transform never pulls a browser into the process. The types below are
 * structural, not imported from Playwright, which keeps the published `.d.ts`
 * free of a dependency the consumer may not have installed.
 *
 * The browser BINARY is a separate, explicit install:
 *
 *   pnpm exec playwright-core install chromium
 */

import { resolve as resolvePath } from "node:path";
import type { CaptureBundleReadProfile, ScreenshotEvidenceRef } from "@apatureai/lattice";
import type { CdpSessionLike } from "./cdp-types.js";
import type { CdpCaptureOptions } from "./capture.js";
import { captureFromCdpSession, captureIdFor, routeOf } from "./capture.js";

// --- Structural view of the slice of Playwright this module drives -------

export interface CaptureCdpProvider {
  newCDPSession(page: never): Promise<CdpSessionLike>;
}

export interface CapturablePage {
  url(): string;
  evaluate(expression: string): Promise<unknown>;
  screenshot(options: { path: string }): Promise<unknown>;
  context(): CaptureCdpProvider;
}

interface ContextLike extends CaptureCdpProvider {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface PageLike extends CapturablePage {
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
}

interface BrowserLike {
  newContext(options: Record<string, unknown>): Promise<ContextLike>;
  close(): Promise<void>;
}

interface PlaywrightLike {
  chromium: { launch(options: Record<string, unknown>): Promise<BrowserLike> };
}

// --- Options -------------------------------------------------------------

export interface CaptureUrlOptions extends CdpCaptureOptions {
  /** Viewport in CSS pixels. Defaults to 1440x900 at deviceScaleFactor 1. */
  readonly viewport?: {
    readonly width: number;
    readonly height: number;
    readonly deviceScaleFactor?: number;
  };
  /** Route recorded on the bundle. Defaults to the URL's `pathname + search`. */
  readonly route?: string;
  /** Wait for this selector before capturing. */
  readonly waitForSelector?: string;
  /** Extra quiet time after load and fonts, in ms. Default 300. */
  readonly settleMs?: number;
  /** Scroll here before capturing. Default the top of the page. */
  readonly scrollTo?: { readonly x: number; readonly y: number };
  /** Write a viewport screenshot here and reference it from the bundle. */
  readonly screenshotPath?: string;
  /** Emulate this color scheme. */
  readonly colorScheme?: "light" | "dark";
  /** Navigation and selector timeout in ms. Default 30000. */
  readonly timeoutMs?: number;
  /** Run with a visible window. Default headless. */
  readonly headed?: boolean;
  /** Explicit Chromium binary, for an environment that manages its own. */
  readonly executablePath?: string;
}

const DEFAULT_VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 } as const;

/** The charset the view schema admits after the `artifact://` scheme. */
const ARTIFACT_REF_SEGMENT = /[^A-Za-z0-9._:-]+/g;

/**
 * Mint the logical `artifact://` ref recorded for a screenshot.
 *
 * It is deliberately NOT the local file path. Two reasons, both load-bearing:
 *
 *  - The view schema (`schemas/ui-graph-view.schema.json`) admits only
 *    `^artifact://[A-Za-z0-9._:/-]+$` for `evidenceRequests[].sourceArtifactRef`,
 *    and that ref is copied straight out of the capture bundle. A `file://…`
 *    path made every `--screenshot` run emit a view that failed its own
 *    published schema.
 *  - An absolute path is machine-specific, so putting it in the bundle would
 *    break the property the capture adapter exists to provide: the same page
 *    captured twice seals to the same bytes.
 *
 * The ref is derived from the capture id and frame id, both of which are already
 * capture-local and charset-safe, so it is stable across machines and output
 * directories. The pixels stay where the caller asked for them; only the pointer
 * is logical.
 */
export function screenshotArtifactRef(captureId: string, frameId: string): string {
  const safe = (part: string): string => {
    const cleaned = part.replace(ARTIFACT_REF_SEGMENT, "-").replace(/^-+|-+$/g, "");
    return cleaned === "" ? "unknown" : cleaned;
  };
  return `artifact://capture/${safe(captureId)}/${safe(frameId)}/screenshot.png`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

async function loadPlaywright(): Promise<PlaywrightLike> {
  try {
    return (await import("playwright-core")) as unknown as PlaywrightLike;
  } catch (cause) {
    throw new Error(
      "playwright-core is not installed. It is an optional peer dependency of " +
        "@apatureai/lattice-capture: install it with `pnpm add -D playwright-core`, " +
        "then install the browser with `pnpm exec playwright-core install chromium`.",
      { cause },
    );
  }
}

/**
 * Pause every animation so a second layout probe sees the same boxes as the
 * first. Best effort: a non-Chromium target simply keeps animating and the
 * capture reports `pageHealth.stable: false` instead of pretending.
 */
async function freezeAnimations(session: CdpSessionLike, page: CapturablePage): Promise<void> {
  try {
    await session.send("Animation.enable");
    await session.send("Animation.setPlaybackRate", { playbackRate: 0 });
  } catch {
    // Animation domain unavailable; the Web Animations pause below still applies.
  }
  await page
    .evaluate("(document.getAnimations ? document.getAnimations().forEach((a) => a.pause()) : null, null)")
    .catch(() => undefined);
}

interface PageMetrics {
  scrollX: number;
  scrollY: number;
  dpr: number;
  vw: number;
  vh: number;
}

const METRICS_EXPRESSION = `({
  scrollX: window.scrollX,
  scrollY: window.scrollY,
  dpr: window.devicePixelRatio,
  vw: document.documentElement.clientWidth,
  vh: document.documentElement.clientHeight
})`;

/**
 * Capture from a Playwright `Page` that the caller already navigated and
 * settled. Use this when the capture has to happen inside an existing session
 * (an authenticated context, a page mid-flow); use `captureUrl` for a page you
 * can just open.
 */
export async function captureFromPage(
  page: CapturablePage,
  options: CaptureUrlOptions = {},
): Promise<CaptureBundleReadProfile> {
  const session = await page.context().newCDPSession(page as never);
  await freezeAnimations(session, page);

  const metrics = (await page.evaluate(METRICS_EXPRESSION)) as PageMetrics;
  const url = page.url();

  const bundle = await captureFromCdpSession(
    session,
    {
      url,
      route: options.route ?? routeOf(url),
      viewportWidthCssPx: metrics.vw,
      viewportHeightCssPx: metrics.vh,
      deviceScaleFactor: metrics.dpr,
      scrollXCssPx: metrics.scrollX,
      scrollYCssPx: metrics.scrollY,
    },
    { ...options, captureId: options.captureId ?? captureIdFor(url) },
  );

  if (options.screenshotPath === undefined) return bundle;

  const path = resolvePath(options.screenshotPath);
  await page.screenshot({ path });
  const frameId = bundle.documents[0]?.frameId ?? "frame_0";
  const evidence: ScreenshotEvidenceRef = {
    artifactRef: screenshotArtifactRef(bundle.captureId, frameId),
    frameId,
    widthImagePx: Math.round(metrics.vw * metrics.dpr),
    heightImagePx: Math.round(metrics.vh * metrics.dpr),
    deviceScaleFactor: metrics.dpr,
  };
  return { ...bundle, screenshotEvidence: [evidence] };
}

/**
 * Open `url` in a fresh headless Chromium, wait for it to settle, and return the
 * capture bundle. The browser is always closed, including on failure.
 */
export async function captureUrl(
  url: string,
  options: CaptureUrlOptions = {},
): Promise<CaptureBundleReadProfile> {
  const { chromium } = await loadPlaywright();
  const viewport = { ...DEFAULT_VIEWPORT, ...options.viewport };
  const timeout = options.timeoutMs ?? 30_000;

  const browser = await chromium.launch({
    headless: options.headed !== true,
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
  });
  try {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      ...(options.colorScheme === undefined ? {} : { colorScheme: options.colorScheme }),
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load", timeout });
    if (options.waitForSelector !== undefined) {
      await page.waitForSelector(options.waitForSelector, { timeout });
    }
    await page.evaluate("document.fonts ? document.fonts.ready.then(() => null) : null").catch(() => undefined);
    if (options.scrollTo !== undefined) {
      await page.evaluate(`(window.scrollTo(${options.scrollTo.x}, ${options.scrollTo.y}), null)`);
    }
    await delay(options.settleMs ?? 300);
    return await captureFromPage(page, options);
  } finally {
    await browser.close();
  }
}
