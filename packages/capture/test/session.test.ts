/**
 * The CDP driver, against a fake session.
 *
 * `captureFromCdpSession` only moves bytes: it enables two domains, probes the
 * page for stability, walks the frame tree for per-frame accessibility, and
 * hands everything to the pure transform. A fake session replaying the frozen
 * recording pins that choreography, including the parts that only show up when
 * the protocol misbehaves.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { captureFromCdpSession } from "../src/index.js";
import type { CdpAxNode, CdpDomSnapshot, CdpSessionLike } from "../src/index.js";

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

/** The protocol frame ids the recording's accessibility nodes were tagged with. */
const FRAME_IDS = [...new Set(recording.axNodes.map((n) => n.frameId!))];

interface FakeOptions {
  /** Return a second, different DOM snapshot so the stability probe fails. */
  unstable?: boolean;
  /** Frame indexes whose accessibility tree the protocol refuses. */
  axFailsForFrames?: number[];
  /** Reject `Page.getFrameTree`, as a non-Chromium target would. */
  noFrameTree?: boolean;
}

function fakeSession(options: FakeOptions = {}): { session: CdpSessionLike; calls: string[] } {
  const calls: string[] = [];
  let snapshots = 0;

  const session: CdpSessionLike = {
    async send(method, params) {
      calls.push(method);
      switch (method) {
        case "DOMSnapshot.enable":
        case "Accessibility.enable":
        case "Page.enable":
          return {};
        case "DOMSnapshot.captureSnapshot": {
          snapshots += 1;
          if (options.unstable === true && snapshots > 1) {
            const shifted = structuredClone(recording.domSnapshot) as {
              documents: Array<{ layout: { bounds?: number[][] } }>;
            };
            const bounds = shifted.documents[0]!.layout.bounds;
            if (bounds?.[0] !== undefined) bounds[0] = [0, 12, 100, 100];
            return shifted;
          }
          return recording.domSnapshot;
        }
        case "Page.getFrameTree": {
          if (options.noFrameTree === true) throw new Error("Page.getFrameTree is not supported");
          return {
            frameTree: {
              frame: { id: FRAME_IDS[0] },
              childFrames: FRAME_IDS.slice(1).map((id) => ({ frame: { id } })),
            },
          };
        }
        case "Accessibility.getFullAXTree": {
          const frameId = (params as { frameId?: string } | undefined)?.frameId;
          const index = frameId === undefined ? 0 : FRAME_IDS.indexOf(frameId);
          if (options.axFailsForFrames?.includes(index) === true) {
            throw new Error(`no accessibility tree for frame ${index}`);
          }
          if (frameId === undefined) return { nodes: recording.axNodes };
          return { nodes: recording.axNodes.filter((n) => n.frameId === frameId) };
        }
        case "DOM.enable":
          return {};
        case "DOM.getDocument":
          return { root: { nodeId: 1 } };
        case "DOM.querySelectorAll":
          return { nodeIds: [42] };
        case "DOM.describeNode":
          return { node: { backendNodeId: 4242 } };
        case "Animation.enable":
        case "Animation.setPlaybackRate":
          return {};
        default:
          throw new Error(`unexpected CDP call ${method}`);
      }
    },
  };
  return { session, calls };
}

const PAGE = recording.page;

describe("captureFromCdpSession", () => {
  it("enables the domains it needs and returns a bundle lattice can read", async () => {
    const { session, calls } = fakeSession();
    const bundle = await captureFromCdpSession(session, PAGE, { stabilityProbeMs: 0 });

    expect(calls).toContain("DOMSnapshot.enable");
    expect(calls).toContain("Accessibility.enable");
    expect(bundle.documents.length).toBe(2);
    expect(bundle.documents[0]!.domLayoutNodes.length).toBeGreaterThan(50);
  });

  it("asks for the accessibility tree once per frame, not once per page", async () => {
    const { session, calls } = fakeSession();
    await captureFromCdpSession(session, PAGE, { stabilityProbeMs: 0 });
    const axCalls = calls.filter((c) => c === "Accessibility.getFullAXTree");
    expect(axCalls).toHaveLength(FRAME_IDS.length);
  });

  it("reports a frame whose accessibility tree the protocol refuses, and keeps going", async () => {
    const { session } = fakeSession({ axFailsForFrames: [1] });
    const bundle = await captureFromCdpSession(session, PAGE, { stabilityProbeMs: 0 });
    expect(bundle.pageHealth.reasons).toContain("accessibility_tree_unavailable_for_frame_1");
    expect(bundle.documents[0]!.accessibilityNodes.length).toBeGreaterThan(50);
    expect(bundle.documents[1]!.accessibilityNodes).toHaveLength(0);
  });

  it("falls back to a single accessibility call when the frame tree is unavailable", async () => {
    const { session, calls } = fakeSession({ noFrameTree: true });
    const bundle = await captureFromCdpSession(session, PAGE, { stabilityProbeMs: 0 });
    expect(calls.filter((c) => c === "Accessibility.getFullAXTree")).toHaveLength(1);
    expect(bundle.documents[0]!.accessibilityNodes.length).toBeGreaterThan(50);
  });

  it("takes two snapshots when probing, and reports a page that moved", async () => {
    const { session, calls } = fakeSession({ unstable: true });
    const bundle = await captureFromCdpSession(session, PAGE, { stabilityProbeMs: 1 });
    expect(calls.filter((c) => c === "DOMSnapshot.captureSnapshot")).toHaveLength(2);
    expect(bundle.pageHealth.stable).toBe(false);
    expect(bundle.pageHealth.reasons).toContain("layout_changed_within_1ms");
  });

  it("calls a skipped probe unverified rather than claiming the page was stable", async () => {
    const { session } = fakeSession();
    const bundle = await captureFromCdpSession(session, PAGE, { stabilityProbeMs: 0 });
    expect(bundle.pageHealth.stable).toBe(false);
    expect(bundle.pageHealth.reasons).toContain("stability_probe_skipped");
  });

  it("resolves redaction selectors through the protocol before capturing", async () => {
    const { session, calls } = fakeSession();
    const bundle = await captureFromCdpSession(session, PAGE, {
      stabilityProbeMs: 0,
      redactSelectors: ['[data-testid="billing-contact"]'],
    });
    expect(calls).toContain("DOM.querySelectorAll");
    expect(bundle.redaction.applied).toBe(true);
    expect(bundle.redaction.policyVersion).toBe("capture-selector-redaction@1");
  });

  it("does not touch the DOM domain when nothing is redacted", async () => {
    const { session, calls } = fakeSession();
    const bundle = await captureFromCdpSession(session, PAGE, { stabilityProbeMs: 0 });
    expect(calls).not.toContain("DOM.querySelectorAll");
    expect(bundle.redaction.applied).toBe(false);
    expect(bundle.redaction.redactedSourceIds).toEqual([]);
  });
});
