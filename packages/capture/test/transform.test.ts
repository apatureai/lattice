/**
 * The adapter, pinned against a frozen Chrome DevTools Protocol recording.
 *
 * `test/fixtures/cdp-recording.json` is exactly what Chromium reported for
 * `test/fixtures/page.html` (re-record it with
 * `node packages/capture/scripts/record-fixture.mjs`). Running the transform
 * over it exercises every decision the adapter makes with no browser installed,
 * which is what keeps the default suite hermetic.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildUiGraph,
  canonicalize,
  queryUiGraph,
  validateCaptureBundle,
  validateView,
  type CaptureBundleReadProfile,
} from "@apature/ui-graph";
import {
  captureBundleFromCdp,
  captureIdFor,
  implicitRole,
  locationIndependentUrl,
  routeOf,
  screenshotArtifactRef,
  type CaptureTransformInput,
  type CaptureTransformOptions,
  type CdpAxNode,
  type CdpDomSnapshot,
} from "../src/index.js";

interface Recording {
  domSnapshot: CdpDomSnapshot;
  axNodes: CdpAxNode[];
  page: CaptureTransformInput["page"];
}

const recording = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/cdp-recording.json", import.meta.url)), "utf8"),
) as Recording;

const BASE_OPTIONS: CaptureTransformOptions = {
  captureId: "cap_fixture_page",
  captureVersion: "playwright-cdp-capture@1",
  repository: { owner: "apatureai", name: "lattice" },
  maxNodes: 4000,
  maxTextRuns: 4000,
  redactionPolicyVersion: "capture-selector-redaction@1",
  redactionApplied: false,
  redactionMask: "[redacted]",
  stable: true,
};

function transform(overrides: Partial<CaptureTransformOptions> = {}): CaptureBundleReadProfile {
  return captureBundleFromCdp({
    domSnapshot: recording.domSnapshot,
    axNodes: recording.axNodes,
    page: recording.page,
    options: { ...BASE_OPTIONS, ...overrides },
  });
}

/** The backend node id of the element carrying `data-testid="<value>"`. */
function backendIdOfTestId(value: string): number {
  const { strings } = recording.domSnapshot;
  for (const doc of recording.domSnapshot.documents) {
    const attributes = doc.nodes.attributes ?? [];
    const backendIds = doc.nodes.backendNodeId ?? [];
    for (let i = 0; i < attributes.length; i += 1) {
      const flat = attributes[i] ?? [];
      for (let k = 0; k + 1 < flat.length; k += 2) {
        if (strings[flat[k] as number] === "data-testid" && strings[flat[k + 1] as number] === value) {
          return backendIds[i] as number;
        }
      }
    }
  }
  throw new Error(`no element with data-testid="${value}" in the recording`);
}

const bundle = transform();
const main = bundle.documents[0]!;

describe("captureBundleFromCdp: shape lattice accepts", () => {
  it("passes lattice's own capture read-profile validation", () => {
    const result = validateCaptureBundle(bundle);
    expect(result.ok).toBe(true);
  });

  it("reports the schema version and capture version lattice supports", () => {
    expect(bundle.schemaVersion).toBe("1.0.0");
    expect(bundle.captureVersion).toBe("playwright-cdp-capture@1");
  });

  it("captured the whole rendered page, not a handful of nodes", () => {
    expect(main.domLayoutNodes.length).toBeGreaterThan(50);
    expect(main.accessibilityNodes.length).toBeGreaterThan(50);
    expect((main.textRuns ?? []).length).toBeGreaterThan(30);
  });
});

describe("referential integrity", () => {
  const domIds = new Set(bundle.documents.flatMap((d) => d.domLayoutNodes.map((n) => n.sourceId)));

  it("every parentSourceId resolves to an emitted DOM node", () => {
    for (const doc of bundle.documents) {
      for (const node of doc.domLayoutNodes) {
        if (node.parentSourceId !== undefined) expect(domIds.has(node.parentSourceId)).toBe(true);
      }
    }
  });

  it("every text run points at an emitted DOM node, and back", () => {
    for (const doc of bundle.documents) {
      const runIds = new Set((doc.textRuns ?? []).map((r) => r.sourceId));
      for (const run of doc.textRuns ?? []) {
        expect(domIds.has(run.domSourceId!)).toBe(true);
      }
      for (const node of doc.domLayoutNodes) {
        for (const id of node.textSourceIds ?? []) expect(runIds.has(id)).toBe(true);
      }
    }
  });

  it("every accessibility parent link resolves within the same capture", () => {
    const axIds = new Set(bundle.documents.flatMap((d) => d.accessibilityNodes.map((n) => n.sourceId)));
    for (const doc of bundle.documents) {
      for (const node of doc.accessibilityNodes) {
        if (node.parentSourceId !== undefined) expect(axIds.has(node.parentSourceId)).toBe(true);
        if (node.backendDomSourceId !== undefined) expect(domIds.has(node.backendDomSourceId)).toBe(true);
      }
    }
  });
});

describe("the accessibility join, which is the point of using CDP", () => {
  it("joins almost every accessibility node to a DOM node by backend id", () => {
    const joined = main.accessibilityNodes.filter((n) => n.backendDomSourceId !== undefined);
    // Explicit-id fusion, not geometric overlap. A handful of synthetic nodes
    // (the web-area root) legitimately have no DOM element behind them.
    expect(joined.length / main.accessibilityNodes.length).toBeGreaterThan(0.9);
  });

  it("drops the StaticText leaves that would duplicate a text run", () => {
    const staticText = main.accessibilityNodes.filter(
      (n) => n.role === "StaticText" && n.backendDomSourceId === undefined,
    );
    expect(staticText).toHaveLength(0);
  });

  it("reads the accessibility tree of the iframe too, not just the main frame", () => {
    const child = bundle.documents[1]!;
    expect(child.accessibilityNodes.length).toBeGreaterThan(0);
    expect(child.accessibilityNodes.some((n) => n.role === "heading")).toBe(true);
  });
});

describe("frames", () => {
  it("nests the iframe document under its owner with the owner's offset", () => {
    const child = bundle.documents[1]!;
    expect(child.frameId).toBe("frame_1");
    expect(child.parentFrameId).toBe("frame_0");
    const [a, b, c, d, tx, ty] = child.transformToParent!;
    expect([a, b, c, d]).toEqual([1, 0, 0, 1]);
    const iframe = main.domLayoutNodes.find((n) => n.tag === "iframe")!;
    expect(tx).toBe(iframe.bounds!.x);
    expect(ty).toBe(iframe.bounds!.y);
  });
});

describe("text runs", () => {
  it("recombines the line boxes of a wrapped paragraph into one run", () => {
    // "Degraded, 21 minutes ago" wraps inside a 220px card. Emitting one run per
    // line box would tell lattice that one element carries two different texts,
    // which its fusion reads as a text conflict on a perfectly ordinary
    // paragraph.
    const runs = (main.textRuns ?? []).filter((r) => r.text.startsWith("Degraded"));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.text).toBe("Degraded, 21 minutes ago");
    expect(runs[0]!.bounds!.height).toBeGreaterThan(30); // the union of two lines
  });

  it("never captures the value of a form field", () => {
    expect(JSON.stringify(bundle)).not.toContain("4111 1111 1111 1111");
  });
});

describe("roles and durable attributes", () => {
  it("gives the DOM side a role so a disagreement has two claims to keep", () => {
    const loose = main.domLayoutNodes.find((n) => n.attributes?.["data-testid"] === "loose-item")!;
    expect(loose.tag).toBe("li");
    expect(loose.role).toBe("listitem");
  });

  it("prefers an explicit role attribute over the implicit one", () => {
    const cta = main.domLayoutNodes.find((n) => n.attributes?.["data-testid"] === "new-review")!;
    expect(cta.tag).toBe("a");
    expect(cta.role).toBe("button");
  });

  it("copies the four durable attributes and nothing else", () => {
    const cta = main.domLayoutNodes.find((n) => n.attributes?.["data-testid"] === "new-review")!;
    expect(Object.keys(cta.attributes!).sort()).toEqual(["data-testid", "href"]);
  });

  it("maps tags to implicit ARIA roles, and abstains where the mapping is contextual", () => {
    expect(implicitRole("a", { href: "/x" })).toBe("link");
    expect(implicitRole("a", {})).toBeUndefined();
    expect(implicitRole("input", { type: "checkbox" })).toBe("checkbox");
    expect(implicitRole("input", {})).toBe("textbox");
    expect(implicitRole("select", { multiple: "" })).toBe("listbox");
    expect(implicitRole("select", {})).toBe("combobox");
    expect(implicitRole("section", {})).toBeUndefined();
    expect(implicitRole("section", { "aria-label": "Env" })).toBe("region");
    expect(implicitRole("header", {})).toBeUndefined();
    expect(implicitRole("marquee", {})).toBeUndefined();
  });
});

describe("style facts, in the shape lattice's projection reads", () => {
  it("carries colors, lengths, radii and spacing for a styled element", () => {
    const cta = main.domLayoutNodes.find((n) => n.attributes?.["data-testid"] === "new-review")!;
    const facts = cta.styleFacts!;
    expect(facts["backgroundColor"]).toBe("rgb(59, 91, 219)");
    expect(facts["fontSize"]).toBe("15px");
    expect(facts["borderRadiusTopLeft"]).toBe("7px");
    expect(facts["paddingLeft"]).toBe("18px");
  });

  it("omits the values that mean the property was never set", () => {
    for (const node of main.domLayoutNodes) {
      expect(node.styleFacts?.["lineHeight"]).not.toBe("normal");
      expect(node.styleFacts?.["rowGap"]).not.toBe("normal");
    }
  });
});

describe("producer-side redaction", () => {
  const redacted = transform({
    redactedBackendNodeIds: [backendIdOfTestId("billing-contact")],
    redactionApplied: true,
  });

  it("masks the text and lists every affected source id", () => {
    expect(redacted.redaction.applied).toBe(true);
    expect(redacted.redaction.redactedSourceIds.length).toBeGreaterThanOrEqual(2);
    const masked = redacted.documents[0]!.textRuns!.filter((r) => r.text === "[redacted]");
    expect(masked).toHaveLength(1);
    expect(redacted.redaction.redactedSourceIds).toContain(masked[0]!.sourceId);
  });

  it("leaves no trace of the redacted text anywhere in the bundle", () => {
    expect(JSON.stringify(bundle)).toContain("billing@example.invalid");
    expect(JSON.stringify(redacted)).not.toContain("billing@example.invalid");
  });
});

describe("budgets degrade, they never throw", () => {
  it("stops at maxNodes and says so instead of silently truncating", () => {
    const small = transform({ maxNodes: 5 });
    expect(small.documents[0]!.domLayoutNodes).toHaveLength(5);
    expect(small.pageHealth.partial).toBe(true);
    expect(small.pageHealth.reasons).toContain("node_budget_exhausted");
  });

  it("stops at maxTextRuns and says so", () => {
    const small = transform({ maxTextRuns: 3 });
    expect(small.documents[0]!.textRuns).toHaveLength(3);
    expect(small.pageHealth.partial).toBe(true);
    expect(small.pageHealth.reasons).toContain("text_run_budget_exhausted");
  });

  it("carries the caller's page-health reasons through", () => {
    const shaky = transform({ stable: false, healthReasons: ["layout_changed_within_250ms"] });
    expect(shaky.pageHealth.stable).toBe(false);
    expect(shaky.pageHealth.reasons).toContain("layout_changed_within_250ms");
  });
});

describe("determinism, which is what makes the content hash worth having", () => {
  it("produces a byte-identical bundle from the same protocol payload", () => {
    expect(canonicalize(transform())).toBe(canonicalize(transform()));
  });

  it("uses no per-session browser id anywhere in the bundle", () => {
    // Chromium's frame ids are 32 hex characters and change every launch. If one
    // reached the bundle, the same page would seal to a new snapshotId each run.
    const protocolFrameId = recording.domSnapshot.strings.find((s) => /^[0-9A-F]{32}$/.test(s));
    expect(protocolFrameId).toBeDefined();
    expect(JSON.stringify(bundle)).not.toContain(protocolFrameId!);
    expect(bundle.documents.map((d) => d.frameId)).toEqual(["frame_0", "frame_1"]);
  });
});

describe("the whole path: recorded page in, queryable scene graph out", () => {
  it("builds a sealed snapshot and renders schema-valid views", async () => {
    const { snapshot } = await buildUiGraph({
      capture: bundle,
      options: {
        builderVersion: "ui-graph-builder@0.1.0",
        schemaVersion: "1.0.0",
        relationPolicyVersion: "relations@1",
        dnaProjectionVersion: "dna-projection@1",
        redactionPolicyVersion: bundle.redaction.policyVersion,
        useMode: "offline_eval",
        maxNodes: 2000,
        maxPersistedEdgesPerNode: 8,
        repeatedRegionThreshold: 3,
        textPolicy: "truncate",
        includeHiddenExplanatoryNodes: false,
      },
    });

    expect(snapshot.metrics.graph.nodes).toBeGreaterThan(50);
    // The detached <li> and the <summary> disclosure widget are places where the
    // DOM's implicit role and the accessibility tree genuinely differ.
    expect(snapshot.metrics.graph.conflictCount).toBeGreaterThan(0);

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

    const actions = (JSON.parse(view.text) as { actions: Array<{ name?: string }> }).actions;
    expect(actions.length).toBeGreaterThan(5);
    expect(actions.some((a) => a.name === "New review")).toBe(true);
  });

  it("every view is smaller than the capture it came from", async () => {
    const { snapshot } = await buildUiGraph({
      capture: bundle,
      options: {
        builderVersion: "ui-graph-builder@0.1.0",
        schemaVersion: "1.0.0",
        relationPolicyVersion: "relations@1",
        dnaProjectionVersion: "dna-projection@1",
        redactionPolicyVersion: bundle.redaction.policyVersion,
        useMode: "offline_eval",
        maxNodes: 2000,
        maxPersistedEdgesPerNode: 8,
        repeatedRegionThreshold: 3,
        textPolicy: "truncate",
        includeHiddenExplanatoryNodes: false,
      },
    });
    const captureBytes = Buffer.byteLength(canonicalize(bundle), "utf8");
    for (const kind of ["summary", "actionMap"] as const) {
      const view = queryUiGraph({
        snapshot,
        spec: {
          kind,
          maxTextTokens: 100_000,
          maxNodes: 400,
          maxEdges: 400,
          maxCrops: 0,
          includeSensitive: false,
          tokenizerProfile: "char-quarter-estimate@1",
          rendererVersion: "ui-graph-renderer@0.2.0",
        },
      });
      expect(view.budget.serializedBytes).toBeLessThan(captureBytes);
    }
  });
});

describe("capture identity helpers", () => {
  it("derives a capture id from the url, never from a clock or a random source", () => {
    expect(captureIdFor("https://example.com/app?tab=1")).toBe(captureIdFor("https://example.com/app?tab=1"));
    expect(captureIdFor("https://example.com/app")).toBe("cap_example.com-app");
  });

  it("reads the route off the url and survives one that does not parse", () => {
    expect(routeOf("https://example.com/a/b?c=1")).toBe("/a/b?c=1");
    expect(routeOf("not a url")).toBe("not a url");
  });
});

/**
 * A `file:` URL names a machine, not just a page. Everything identity-shaped is
 * derived from the URL, so leaving one whole put the checkout directory (and
 * usually an account name) into `captureId`, into the `artifact://` refs minted
 * from it, into the default `route`, and through `deterministicInputHash` into
 * the sealed snapshot id: the same page in two clones sealed to two different
 * ids.
 */
describe("a file: capture identifies the page, not the machine", () => {
  const HERE = "file:///Users/someone/checkouts/lattice/test/fixtures/page.html";
  const THERE = "file:///var/tmp/build-9182/page.html";

  it("reduces a file url to the file, and leaves every other scheme alone", () => {
    expect(locationIndependentUrl(HERE)).toBe("file:///page.html");
    expect(locationIndependentUrl("file:///a/b/report.html?tab=1")).toBe("file:///report.html?tab=1");
    expect(locationIndependentUrl("https://example.com/a/b?c=1")).toBe("https://example.com/a/b?c=1");
    expect(locationIndependentUrl("about:srcdoc")).toBe("about:srcdoc");
    expect(locationIndependentUrl("not a url")).toBe("not a url");
  });

  it("gives the same page the same capture id from two different checkouts", () => {
    expect(captureIdFor(HERE)).toBe("cap_page.html");
    expect(captureIdFor(THERE)).toBe(captureIdFor(HERE));
  });

  it("keeps the screenshot artifact ref free of the directory it was captured from", () => {
    const ref = screenshotArtifactRef(captureIdFor(HERE), "frame_0");
    expect(ref).toBe("artifact://capture/cap_page.html/frame_0/screenshot.png");
    expect(ref).not.toContain("someone");
    expect(ref).not.toContain("checkouts");
  });

  it("defaults the route to the page, not to an absolute path", () => {
    expect(routeOf(HERE)).toBe("/page.html");
    expect(routeOf(THERE)).toBe(routeOf(HERE));
  });

  it("holds a committed recording with no checkout path in it", () => {
    // Chromium reports the absolute path of whichever checkout ran
    // `scripts/record-fixture.mjs`, in `documentURL`, in the string table and
    // in an accessibility node's `url` property. It was hand-scrubbed out of
    // this file once already. The recorder now applies the same reduction the
    // adapter does, and this fails if a future re-record stops doing it.
    const directoryInAFileUrl = /file:\/\/\/[^"]*\//;
    expect(JSON.stringify(recording)).not.toMatch(directoryInAFileUrl);
  });

  it("records a document url that does not move with the checkout", () => {
    const at = (documentURL: string): CaptureBundleReadProfile => {
      const domSnapshot = structuredClone(recording.domSnapshot);
      domSnapshot.documents[0]!.documentURL = domSnapshot.strings.length;
      (domSnapshot.strings as string[]).push(documentURL);
      return captureBundleFromCdp({
        domSnapshot,
        axNodes: recording.axNodes,
        page: { ...recording.page, url: documentURL, route: routeOf(documentURL) },
        options: { ...BASE_OPTIONS, captureId: captureIdFor(documentURL) },
      });
    };

    const here = at(HERE);
    const there = at(THERE);
    expect(here.documents[0]!.url).toBe("file:///page.html");
    // The whole bundle, byte for byte: this is what `deterministicInputHash`
    // reads, so anything left in it would move the sealed snapshot id.
    expect(canonicalize(there)).toBe(canonicalize(here));
    expect(canonicalize(here)).not.toContain("checkouts");
  });
});
