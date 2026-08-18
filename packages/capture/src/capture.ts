/**
 * The CDP driver: two protocol calls, a stability probe, and the pure transform.
 *
 * This module knows the Chrome DevTools Protocol but not Playwright. It takes
 * anything with a `send(method, params)` method, which is what Playwright's
 * `CDPSession` and puppeteer's both are, so the browser library stays a detail
 * of `browser.ts` and this layer can be driven by a recorded session in tests.
 */

import type { CaptureBundleReadProfile, ScreenshotEvidenceRef } from "@apature/ui-graph";
import type { CdpAxNode, CdpAxTree, CdpDomSnapshot, CdpSessionLike } from "./cdp-types.js";
import { REQUESTED_COMPUTED_STYLES } from "./style.js";
import type { CapturePageFacts } from "./transform.js";
import { captureBundleFromCdp, locationIndependentUrl } from "./transform.js";

/** Identifies the adapter that produced a bundle; travels into the snapshot. */
export const CAPTURE_VERSION = "playwright-cdp-capture@1";

export interface CdpCaptureOptions {
  readonly repository?: { readonly owner: string; readonly name: string };
  readonly captureId?: string;
  readonly headSha?: string;
  readonly maxNodes?: number;
  readonly maxTextRuns?: number;
  readonly includeNonRendered?: boolean;
  /**
   * CSS selectors whose subtrees are redacted at the producer: their text runs
   * are replaced with the mask and every affected source id is listed on the
   * bundle, so lattice flags the nodes sensitive and withholds them from views.
   * Main frame only.
   */
  readonly redactSelectors?: readonly string[];
  readonly redactionMask?: string;
  readonly redactionPolicyVersion?: string;
  readonly screenshotEvidence?: readonly ScreenshotEvidenceRef[];
  /**
   * Take a second `DOMSnapshot` after this many ms and compare layout boxes. A
   * mismatch is reported as `pageHealth.stable: false`, never as a failure.
   * Set to 0 to skip the probe (then stability is reported as unverified).
   */
  readonly stabilityProbeMs?: number;
}

const DEFAULTS = {
  maxNodes: 4000,
  maxTextRuns: 4000,
  redactionMask: "[redacted]",
  redactionPolicyVersion: "capture-selector-redaction@1",
  stabilityProbeMs: 250,
} as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Flatten every layout box of every document into one comparable string. */
function layoutDigest(snapshot: CdpDomSnapshot): string {
  const parts: string[] = [];
  for (const doc of snapshot.documents) {
    for (const bounds of doc.layout.bounds ?? []) {
      parts.push(bounds.map((n) => Math.round(n * 10)).join(","));
    }
  }
  return parts.join(";");
}

async function takeSnapshot(session: CdpSessionLike): Promise<CdpDomSnapshot> {
  return (await session.send("DOMSnapshot.captureSnapshot", {
    computedStyles: [...REQUESTED_COMPUTED_STYLES],
    includePaintOrder: true,
    includeDOMRects: false,
  })) as CdpDomSnapshot;
}

interface FrameTreeNode {
  frame: { id: string };
  childFrames?: FrameTreeNode[];
}

/** Every frame in the target, main frame first, in tree order. */
async function frameIds(session: CdpSessionLike): Promise<string[]> {
  await session.send("Page.enable");
  const { frameTree } = (await session.send("Page.getFrameTree")) as { frameTree: FrameTreeNode };
  const out: string[] = [];
  const walk = (node: FrameTreeNode): void => {
    out.push(node.frame.id);
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(frameTree);
  return out;
}

/**
 * The accessibility tree of every frame, not just the main one.
 *
 * `Accessibility.getFullAXTree` returns one frame's document at a time, so an
 * iframe's semantics are simply absent unless you ask per frame. AX node ids are
 * only unique within a frame, so each frame's ids are namespaced before the
 * trees are merged; otherwise two frames' roots would collide into one node.
 *
 * A frame the protocol refuses (a cross-process iframe, a frame that navigated
 * mid-capture) is reported as a page-health reason, never as a failure: a
 * capture missing one frame's semantics is worth more than no capture.
 */
async function collectAxNodes(
  session: CdpSessionLike,
  reasons: string[],
): Promise<CdpAxNode[]> {
  let frames: string[];
  try {
    frames = await frameIds(session);
  } catch {
    frames = [];
  }
  if (frames.length === 0) {
    const tree = (await session.send("Accessibility.getFullAXTree")) as CdpAxTree;
    return [...(tree.nodes ?? [])];
  }

  const out: CdpAxNode[] = [];
  for (const [index, frameId] of frames.entries()) {
    let tree: CdpAxTree;
    try {
      tree = (await session.send("Accessibility.getFullAXTree", { frameId })) as CdpAxTree;
    } catch {
      reasons.push(`accessibility_tree_unavailable_for_frame_${index}`);
      continue;
    }
    for (const node of tree.nodes ?? []) {
      out.push({
        ...node,
        nodeId: `${index}_${node.nodeId}`,
        ...(node.parentId === undefined ? {} : { parentId: `${index}_${node.parentId}` }),
        frameId,
      });
    }
  }
  return out;
}

/**
 * Resolve CSS selectors to backend node ids in the main frame. Selectors that
 * match nothing are simply absent from the result; a selector the browser
 * rejects raises, because silently redacting nothing would be the dangerous
 * failure mode.
 */
async function resolveSelectors(
  session: CdpSessionLike,
  selectors: readonly string[],
): Promise<number[]> {
  if (selectors.length === 0) return [];
  await session.send("DOM.enable");
  const { root } = (await session.send("DOM.getDocument", { depth: 0 })) as {
    root: { nodeId: number };
  };
  const backendIds: number[] = [];
  for (const selector of selectors) {
    const { nodeIds } = (await session.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector,
    })) as { nodeIds: number[] };
    for (const nodeId of nodeIds) {
      const described = (await session.send("DOM.describeNode", { nodeId })) as {
        node: { backendNodeId?: number };
      };
      if (described.node.backendNodeId !== undefined) backendIds.push(described.node.backendNodeId);
    }
  }
  return backendIds;
}

/**
 * Capture a `CaptureBundleReadProfile` from an open CDP session.
 *
 * `page` carries the facts the protocol does not report: the URL, the viewport
 * in CSS pixels, the device scale factor and the current scroll offsets. The
 * caller is responsible for the page being loaded and settled; this function
 * observes, it does not wait for the page to be ready.
 */
export async function captureFromCdpSession(
  session: CdpSessionLike,
  page: CapturePageFacts,
  options: CdpCaptureOptions = {},
): Promise<CaptureBundleReadProfile> {
  await session.send("DOMSnapshot.enable");
  await session.send("Accessibility.enable");

  const redactedBackendNodeIds = await resolveSelectors(session, options.redactSelectors ?? []);

  const probeMs = options.stabilityProbeMs ?? DEFAULTS.stabilityProbeMs;
  let snapshot = await takeSnapshot(session);
  const healthReasons: string[] = [];
  let stable = true;
  if (probeMs > 0) {
    const first = layoutDigest(snapshot);
    await delay(probeMs);
    snapshot = await takeSnapshot(session);
    if (layoutDigest(snapshot) !== first) {
      stable = false;
      healthReasons.push(`layout_changed_within_${probeMs}ms`);
    }
  } else {
    stable = false;
    healthReasons.push("stability_probe_skipped");
  }

  const axNodes = await collectAxNodes(session, healthReasons);

  return captureBundleFromCdp({
    domSnapshot: snapshot,
    axNodes,
    page,
    options: {
      captureId: options.captureId ?? captureIdFor(page.url),
      captureVersion: CAPTURE_VERSION,
      repository: options.repository ?? { owner: "unknown", name: "unknown" },
      ...(options.headSha === undefined ? {} : { headSha: options.headSha }),
      maxNodes: options.maxNodes ?? DEFAULTS.maxNodes,
      maxTextRuns: options.maxTextRuns ?? DEFAULTS.maxTextRuns,
      ...(options.includeNonRendered === undefined
        ? {}
        : { includeNonRendered: options.includeNonRendered }),
      redactedBackendNodeIds,
      redactionPolicyVersion: options.redactionPolicyVersion ?? DEFAULTS.redactionPolicyVersion,
      redactionApplied: (options.redactSelectors ?? []).length > 0,
      redactionMask: options.redactionMask ?? DEFAULTS.redactionMask,
      ...(options.screenshotEvidence === undefined
        ? {}
        : { screenshotEvidence: options.screenshotEvidence }),
      stable,
      healthReasons,
    },
  });
}

/**
 * A capture id derived from the URL alone, so two captures of the same page get
 * the same id. Deliberately not random and not time-based: `captureId` is an
 * input to the snapshot's content hash, and a random one would make every
 * capture of an unchanged page produce a different snapshot id. The URL is
 * reduced by `locationIndependentUrl` first, so a `file:` capture's id names
 * the page rather than the directory it happens to sit in.
 */
export function captureIdFor(url: string): string {
  const cleaned = locationIndependentUrl(url)
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
  const trimmed = cleaned.replace(/^-+|-+$/g, "").slice(0, 96);
  return `cap_${trimmed === "" ? "page" : trimmed}`;
}

/**
 * `pathname + search` of a URL, or the raw string if it does not parse. A
 * `file:` URL is reduced first, so the default route of a local page is
 * `/page.html` and not the absolute path of somebody's checkout.
 */
export function routeOf(url: string): string {
  try {
    const parsed = new URL(locationIndependentUrl(url));
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
