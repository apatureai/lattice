/**
 * The whole adapter, as a pure function.
 *
 * `captureBundleFromCdp` takes the two Chrome DevTools Protocol payloads and the
 * page facts that go with them, and returns the `CaptureBundleReadProfile` that
 * `buildUiGraph` consumes. It touches no browser, no clock, no randomness and no
 * network: given the same protocol payload it produces a byte-identical bundle.
 *
 * That split is the point. Everything that can go wrong in a capture adapter
 * (which nodes to keep, how to join accessibility to DOM, where a text run's
 * geometry comes from, what "visible" means) lives here, where a frozen protocol
 * payload can pin it down in a test. `capture.ts` only moves bytes.
 *
 * Coordinates: `DOMSnapshot` reports layout boxes in the CSS-pixel coordinate
 * space of their own document, unaffected by scroll. lattice reads capture
 * bounds as frame-local and composes them through `transformToParent`, so the
 * main frame passes through unchanged and each child frame carries the offset of
 * the iframe element that owns it.
 *
 * Identity: the browser's own frame ids, backend node ids and accessibility node
 * ids are all per-session values that change every launch. Copying them into the
 * bundle would put randomness inside lattice's content hash, so the same
 * unchanged page would seal to a different `snapshotId` on every capture, which
 * is precisely the property content addressing exists to provide. So they are
 * replaced by capture-local ordinals assigned in document order (`frame_0`,
 * `dom_0`, `text_0`, `ax_0`, ...). Nothing downstream needs a protocol id: refs
 * are snapshot-local by construction, and cross-capture identity is the lineage
 * matcher's job, off the durable DOM attributes.
 */

import type {
  CaptureAccessibilityNode,
  CaptureBundleReadProfile,
  CaptureDocumentObservation,
  CaptureDomLayoutNode,
  CaptureTextRun,
  ScreenshotEvidenceRef,
} from "@apature/ui-graph";
import type {
  CdpAxNode,
  CdpDocumentSnapshot,
  CdpDomSnapshot,
  CdpRareIntegerData,
} from "./cdp-types.js";
import { implicitRole } from "./roles.js";
import { STYLE_PROPERTIES, VISIBILITY_INDEX, Z_INDEX_INDEX } from "./style.js";

/**
 * The location-independent form of a page URL.
 *
 * A `file:` URL is mostly a description of one machine: the checkout directory,
 * and usually the account name above it. Everything downstream is derived from
 * the URL, so keeping that whole would put the laptop into `captureId`, into
 * the `artifact://capture/<captureId>/…` refs minted from it, into the default
 * `route`, and through `deterministicInputHash` into the sealed snapshot id.
 * Then the same page in two checkouts would seal to two different ids, which is
 * the property content addressing exists to provide. The file's own name is the
 * part that identifies the page; the directories above it identify the machine,
 * so they are dropped. Every other scheme, `http(s)` included, is left exactly
 * as the browser reported it, because there the path is part of the page.
 */
export function locationIndependentUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "file:") return url;
  const name = parsed.pathname.split("/").filter((segment) => segment !== "").pop() ?? "";
  return `file:///${name}${parsed.search}`;
}


/** The capture schema major lattice supports (`SUPPORTED_CAPTURE_MAJORS`). */
export const CAPTURE_SCHEMA_VERSION = "1.0.0";

/** Elements that carry no rendered UI. Skipped before the node budget is spent. */
const SKIPPED_TAGS = new Set([
  "base", "head", "link", "meta", "noscript", "script", "style", "template", "title",
]);

/**
 * The four attributes lattice reads for cross-capture lineage. Nothing else is
 * copied: an adapter that shipped every attribute would put page content into a
 * field the matcher treats as durable identity.
 */
const DURABLE_ATTRIBUTES = ["data-testid", "id", "href", "name"] as const;

/**
 * Accessibility roles that only ever repeat a text node. Chromium emits one per
 * run of text, so an unjoined one would enter lattice as a geometry-less node
 * duplicating a text run that already carries real bounds. Joined ones are kept:
 * there the role is a claim about a DOM element, not a copy of its text.
 */
const AX_TEXT_LEAF_ROLES = new Set(["StaticText", "InlineTextBox", "LineBreak"]);

/**
 * Style values that mean "this property was never set". They survive no
 * downstream normalization (they are neither a color nor a CSS length), so
 * emitting them would only pad the capture the views are measured against.
 */
const INERT_STYLE_VALUES: Readonly<Record<string, string>> = {
  lineHeight: "normal",
  rowGap: "normal",
  columnGap: "normal",
};

/** Accessibility properties kept as node state. Bounded on purpose. */
const AX_STATE_PROPERTIES = new Set([
  "checked", "disabled", "expanded", "focusable", "focused", "haspopup", "invalid",
  "level", "modal", "multiline", "multiselectable", "pressed", "readonly",
  "required", "selected", "valuemax", "valuemin", "valuetext",
]);

export interface CapturePageFacts {
  readonly url: string;
  readonly route: string;
  readonly viewportWidthCssPx: number;
  readonly viewportHeightCssPx: number;
  readonly deviceScaleFactor: number;
  readonly scrollXCssPx: number;
  readonly scrollYCssPx: number;
}

export interface CaptureTransformOptions {
  readonly captureId: string;
  readonly captureVersion: string;
  readonly repository: { readonly owner: string; readonly name: string };
  readonly headSha?: string;
  /** Hard cap on emitted DOM nodes. Exceeding it sets `pageHealth.partial`. */
  readonly maxNodes: number;
  /** Hard cap on emitted text runs. Exceeding it sets `pageHealth.partial`. */
  readonly maxTextRuns: number;
  /** Keep elements with no layout box (`display:none` subtrees). Default false. */
  readonly includeNonRendered?: boolean;
  /** Backend node ids whose subtrees the caller redacted. */
  readonly redactedBackendNodeIds?: readonly number[];
  readonly redactionPolicyVersion: string;
  readonly redactionApplied: boolean;
  /** Replacement text for a redacted run. */
  readonly redactionMask: string;
  readonly screenshotEvidence?: readonly ScreenshotEvidenceRef[];
  /** Page-stability verdict from the caller's probe, with its reasons. */
  readonly stable: boolean;
  readonly healthReasons?: readonly string[];
}

export interface CaptureTransformInput {
  readonly domSnapshot: CdpDomSnapshot;
  readonly axNodes: readonly CdpAxNode[];
  readonly page: CapturePageFacts;
  readonly options: CaptureTransformOptions;
}

// --- CDP decoding helpers ------------------------------------------------

function rareIntegers(data: CdpRareIntegerData | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (data === undefined) return out;
  data.index.forEach((nodeIndex, i) => {
    const value = data.value[i];
    if (value !== undefined) out.set(nodeIndex, value);
  });
  return out;
}

/**
 * Round to 2 decimals. Sub-pixel layout jitter between two runs of the same page
 * would otherwise change the content hash of an otherwise identical capture.
 * `+ 0` normalizes `-0`, which canonical JSON rejects downstream.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

function rectFrom(bounds: readonly number[] | undefined): { x: number; y: number; width: number; height: number } | undefined {
  if (bounds === undefined || bounds.length < 4) return undefined;
  const [x, y, width, height] = bounds as [number, number, number, number];
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return undefined;
  return { x: round2(x), y: round2(y), width: round2(width), height: round2(height) };
}

type PlainRect = { x: number; y: number; width: number; height: number };

/** Smallest rect containing both, ignoring absent ones. */
function unionRect(a: PlainRect | undefined, b: PlainRect | undefined): PlainRect | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x: round2(x), y: round2(y), width: round2(right - x), height: round2(bottom - y) };
}

// --- Per-document decoding ----------------------------------------------

interface DecodedDocument {
  readonly index: number;
  readonly snapshot: CdpDocumentSnapshot;
  /** Stable, capture-local frame id. See the identity note in the header. */
  readonly frameId: string;
  /** The browser's own frame id, kept only to match accessibility nodes back. */
  readonly protocolFrameId: string | undefined;
  readonly nodeCount: number;
  readonly parentIndex: readonly number[];
  readonly nodeType: readonly number[];
  readonly backendNodeId: readonly number[];
  /** node index to layout index. */
  readonly layoutOf: Map<number, number>;
  /** node index to child document index, for iframe owners. */
  readonly contentDocument: Map<number, number>;
}

function decodeDocument(doc: CdpDocumentSnapshot, index: number, str: (i: number | undefined) => string | undefined): DecodedDocument {
  const parentIndex = doc.nodes.parentIndex ?? [];
  const nodeType = doc.nodes.nodeType ?? [];
  const backendNodeId = doc.nodes.backendNodeId ?? [];
  const layoutOf = new Map<number, number>();
  (doc.layout.nodeIndex ?? []).forEach((nodeIdx, layoutIdx) => {
    if (!layoutOf.has(nodeIdx)) layoutOf.set(nodeIdx, layoutIdx);
  });
  return {
    index,
    snapshot: doc,
    frameId: `frame_${index}`,
    protocolFrameId: str(doc.frameId),
    nodeCount: Math.max(parentIndex.length, nodeType.length, backendNodeId.length),
    parentIndex,
    nodeType,
    backendNodeId,
    layoutOf,
    contentDocument: rareIntegers(doc.nodes.contentDocumentIndex),
  };
}

// --- Main transform ------------------------------------------------------

export function captureBundleFromCdp(input: CaptureTransformInput): CaptureBundleReadProfile {
  const { domSnapshot, axNodes, page, options } = input;
  const strings = domSnapshot.strings;
  const str = (i: number | undefined): string | undefined =>
    i === undefined || i < 0 || i >= strings.length ? undefined : strings[i];

  const docs = domSnapshot.documents.map((doc, i) => decodeDocument(doc, i, str));

  // Which document each child frame hangs off, and the iframe element that owns
  // it. Used for `parentFrameId` and the frame-to-parent offset.
  const owner = new Map<number, { doc: DecodedDocument; nodeIndex: number }>();
  for (const doc of docs) {
    for (const [nodeIndex, childDocIndex] of doc.contentDocument) {
      owner.set(childDocIndex, { doc, nodeIndex });
    }
  }

  const budget = { nodes: options.maxNodes, textRuns: options.maxTextRuns };
  let nextDomId = 0;
  let nextTextId = 0;
  const partialReasons: string[] = [];

  /** backend node id to the source id + frame it was emitted under. */
  const emittedByBackendId = new Map<number, { sourceId: string; frameId: string }>();
  const redactedSourceIds: string[] = [];
  const redactedRoots = new Set(options.redactedBackendNodeIds ?? []);

  const documents: CaptureDocumentObservation[] = [];

  for (const doc of docs) {
    const nodes = doc.snapshot.nodes;
    const layout = doc.snapshot.layout;
    const nodeName = nodes.nodeName ?? [];
    const nodeValue = nodes.nodeValue ?? [];
    const attributes = nodes.attributes ?? [];
    const styles = layout.styles ?? [];
    const layoutBounds = layout.bounds ?? [];
    const paintOrders = layout.paintOrders;

    /** node index to the source id emitted for it, for parent resolution. */
    const sourceIdOf = new Map<number, string>();
    /** node index to true when the node or an ancestor was redacted. */
    const redactedNode = new Map<number, boolean>();

    const domLayoutNodes: CaptureDomLayoutNode[] = [];
    const textRuns: CaptureTextRun[] = [];
    const textSourceIdsOf = new Map<string, string[]>();

    const attributesOf = (nodeIndex: number): Record<string, string> => {
      const flat = attributes[nodeIndex] ?? [];
      const out: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const name = str(flat[i]);
        const value = str(flat[i + 1]);
        if (name !== undefined && value !== undefined) out[name.toLowerCase()] = value;
      }
      return out;
    };

    const isRedacted = (nodeIndex: number): boolean => {
      const cached = redactedNode.get(nodeIndex);
      if (cached !== undefined) return cached;
      const backendId = doc.backendNodeId[nodeIndex];
      let value = backendId !== undefined && redactedRoots.has(backendId);
      if (!value) {
        const parent = doc.parentIndex[nodeIndex];
        value = parent !== undefined && parent >= 0 && isRedacted(parent);
      }
      redactedNode.set(nodeIndex, value);
      return value;
    };

    /** Nearest ancestor (inclusive) that was emitted as a DOM node. */
    const nearestEmittedAncestor = (nodeIndex: number): string | undefined => {
      let cursor = doc.parentIndex[nodeIndex];
      while (cursor !== undefined && cursor >= 0) {
        const id = sourceIdOf.get(cursor);
        if (id !== undefined) return id;
        cursor = doc.parentIndex[cursor];
      }
      return undefined;
    };

    for (let nodeIndex = 0; nodeIndex < doc.nodeCount; nodeIndex += 1) {
      if (doc.nodeType[nodeIndex] !== 1) continue;
      const tag = (str(nodeName[nodeIndex]) ?? "").toLowerCase();
      if (tag === "" || SKIPPED_TAGS.has(tag)) continue;

      const layoutIdx = doc.layoutOf.get(nodeIndex);
      if (layoutIdx === undefined && options.includeNonRendered !== true) continue;

      const backendId = doc.backendNodeId[nodeIndex];
      if (backendId === undefined) continue;

      if (budget.nodes <= 0) {
        if (!partialReasons.includes("node_budget_exhausted")) {
          partialReasons.push("node_budget_exhausted");
        }
        break;
      }
      budget.nodes -= 1;

      const sourceId = `dom_${nextDomId}`;
      nextDomId += 1;
      sourceIdOf.set(nodeIndex, sourceId);
      emittedByBackendId.set(backendId, { sourceId, frameId: doc.frameId });

      const attrs = attributesOf(nodeIndex);
      const styleValues = layoutIdx === undefined ? undefined : styles[layoutIdx];
      const styleAt = (i: number): string | undefined => {
        const raw = styleValues === undefined ? undefined : str(styleValues[i]);
        return raw === undefined || raw === "" ? undefined : raw;
      };

      const bounds = layoutIdx === undefined ? undefined : rectFrom(layoutBounds[layoutIdx]);
      const visibility = VISIBILITY_INDEX >= 0 ? styleAt(VISIBILITY_INDEX) : undefined;
      const visible =
        bounds !== undefined &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        visibility !== "hidden" &&
        visibility !== "collapse";

      const styleFacts: Record<string, string | number> = {};
      STYLE_PROPERTIES.forEach(([, fact], i) => {
        if (fact === null) return;
        const value = styleAt(i);
        if (value === undefined || value === INERT_STYLE_VALUES[fact]) return;
        styleFacts[fact] = value;
      });

      const durable: Record<string, string> = {};
      for (const name of DURABLE_ATTRIBUTES) {
        const value = attrs[name];
        if (value !== undefined && value !== "") durable[name] = value;
      }

      const role = attrs["role"] ?? implicitRole(tag, attrs);

      const node: CaptureDomLayoutNode = { sourceId, frameId: doc.frameId, tag, visible };
      const parentSourceId = nearestEmittedAncestor(nodeIndex);
      if (parentSourceId !== undefined) node.parentSourceId = parentSourceId;
      if (role !== undefined) node.role = role;
      if (Object.keys(durable).length > 0) node.attributes = durable;
      if (bounds !== undefined) node.bounds = bounds;
      if (paintOrders !== undefined && layoutIdx !== undefined) {
        const order = paintOrders[layoutIdx];
        if (order !== undefined) node.paintOrder = order;
      }
      if (Z_INDEX_INDEX >= 0) {
        const z = styleAt(Z_INDEX_INDEX);
        if (z === "auto") node.zIndex = "auto";
        else if (z !== undefined && Number.isFinite(Number(z))) node.zIndex = Number(z);
      }
      if (Object.keys(styleFacts).length > 0) node.styleFacts = styleFacts;

      if (isRedacted(nodeIndex)) redactedSourceIds.push(sourceId);
      domLayoutNodes.push(node);
    }

    // --- text runs, one per text node --------------------------------------
    //
    // CDP reports one box per rendered LINE, so a wrapped paragraph arrives as
    // several boxes over one text node. Emitting a run per box would tell
    // lattice that one element carries several different texts, which its
    // fusion correctly reads as a text conflict: a paragraph would be flagged as
    // a source disagreement purely because it wrapped. So the boxes of a text
    // node are recombined here, by character range over the node's own value
    // (never by concatenating slices, which would invent whitespace) and by
    // union of their boxes.
    const boxes = doc.snapshot.textBoxes;
    const boxLayout = boxes?.layoutIndex ?? [];
    const boxBounds = boxes?.bounds ?? [];
    const boxStart = boxes?.start ?? [];
    const boxLength = boxes?.length ?? [];

    interface TextGroup {
      nodeIndex: number;
      layoutIdx: number;
      firstBox: number;
      start: number;
      end: number;
      wholeNode: boolean;
      rect?: { x: number; y: number; width: number; height: number };
    }
    const groups = new Map<number, TextGroup>();

    for (let i = 0; i < boxLayout.length; i += 1) {
      const layoutIdx = boxLayout[i];
      if (layoutIdx === undefined) continue;
      const nodeIndex = (layout.nodeIndex ?? [])[layoutIdx];
      if (nodeIndex === undefined) continue;

      const start = boxStart[i] ?? -1;
      const length = boxLength[i] ?? -1;
      const rect = rectFrom(boxBounds[i]);

      const existing = groups.get(nodeIndex);
      if (existing === undefined) {
        groups.set(nodeIndex, {
          nodeIndex,
          layoutIdx,
          firstBox: i,
          start: start >= 0 ? start : 0,
          end: start >= 0 && length >= 0 ? start + length : 0,
          wholeNode: start < 0 || length < 0,
          ...(rect === undefined ? {} : { rect }),
        });
        continue;
      }
      if (start < 0 || length < 0) existing.wholeNode = true;
      else {
        existing.start = Math.min(existing.start, start);
        existing.end = Math.max(existing.end, start + length);
      }
      existing.rect = unionRect(existing.rect, rect);
    }

    for (const group of groups.values()) {
      const { nodeIndex } = group;
      const whole = str(nodeValue[nodeIndex]) ?? str((layout.text ?? [])[group.layoutIdx]) ?? "";
      const slice = group.wholeNode ? whole : whole.slice(group.start, group.end);
      const text = slice.replace(/\s+/g, " ").trim();
      if (text === "") continue;

      const domSourceId = nearestEmittedAncestor(nodeIndex);
      if (domSourceId === undefined) continue;

      if (budget.textRuns <= 0) {
        if (!partialReasons.includes("text_run_budget_exhausted")) {
          partialReasons.push("text_run_budget_exhausted");
        }
        break;
      }
      budget.textRuns -= 1;

      const runId = `text_${nextTextId}`;
      nextTextId += 1;
      const redacted = isRedacted(nodeIndex);
      if (redacted) redactedSourceIds.push(runId);

      const run: CaptureTextRun = {
        sourceId: runId,
        frameId: doc.frameId,
        text: redacted ? options.redactionMask : text,
        domSourceId,
      };
      if (group.rect !== undefined) run.bounds = group.rect;
      textRuns.push(run);

      const list = textSourceIdsOf.get(domSourceId);
      if (list === undefined) textSourceIdsOf.set(domSourceId, [runId]);
      else list.push(runId);
    }

    for (const node of domLayoutNodes) {
      const ids = textSourceIdsOf.get(node.sourceId);
      if (ids !== undefined) node.textSourceIds = ids;
    }

    const observation: CaptureDocumentObservation = {
      frameId: doc.frameId,
      domLayoutNodes,
      accessibilityNodes: [],
      textRuns,
    };
    const url = str(doc.snapshot.documentURL);
    if (url !== undefined) observation.url = locationIndependentUrl(url);

    const ownedBy = owner.get(doc.index);
    if (ownedBy !== undefined) {
      observation.parentFrameId = ownedBy.doc.frameId;
      const ownerLayoutIdx = ownedBy.doc.layoutOf.get(ownedBy.nodeIndex);
      const ownerRect =
        ownerLayoutIdx === undefined
          ? undefined
          : rectFrom((ownedBy.doc.snapshot.layout.bounds ?? [])[ownerLayoutIdx]);
      observation.transformToParent = ownerRect
        ? [1, 0, 0, 1, ownerRect.x, ownerRect.y]
        : [1, 0, 0, 1, 0, 0];
    }

    documents.push(observation);
  }

  // --- accessibility tree, joined by backend node id ----------------------
  const mainFrameId = documents[0]?.frameId ?? "frame_0";
  const byFrame = new Map<string, CaptureDocumentObservation>();
  for (const observation of documents) byFrame.set(observation.frameId, observation);

  const frameByProtocolId = new Map<string, string>();
  for (const doc of docs) {
    if (doc.protocolFrameId !== undefined) frameByProtocolId.set(doc.protocolFrameId, doc.frameId);
  }

  /** Kept accessibility nodes, in tree order, with their capture-local ids. */
  const axSourceIds = new Map<string, string>();
  for (const ax of axNodes) {
    const backendId = ax.backendDOMNodeId;
    const joined = backendId === undefined ? undefined : emittedByBackendId.get(backendId);
    if (joined === undefined) {
      if (ax.ignored) continue;
      const role = typeof ax.role?.value === "string" ? ax.role.value : "";
      if (AX_TEXT_LEAF_ROLES.has(role)) continue;
    }
    axSourceIds.set(ax.nodeId, `ax_${axSourceIds.size}`);
  }

  for (const ax of axNodes) {
    const sourceId = axSourceIds.get(ax.nodeId);
    if (sourceId === undefined) continue;
    const backendId = ax.backendDOMNodeId;
    const joined = backendId === undefined ? undefined : emittedByBackendId.get(backendId);
    const declaredFrame = ax.frameId === undefined ? undefined : frameByProtocolId.get(ax.frameId);
    const frameId = joined?.frameId ?? declaredFrame ?? mainFrameId;
    const target = byFrame.get(frameId) ?? byFrame.get(mainFrameId);
    if (target === undefined) continue;

    const node: CaptureAccessibilityNode = {
      sourceId,
      frameId,
      ignored: ax.ignored,
    };
    const parentSourceId = ax.parentId === undefined ? undefined : axSourceIds.get(ax.parentId);
    if (parentSourceId !== undefined) node.parentSourceId = parentSourceId;
    const role = typeof ax.role?.value === "string" ? ax.role.value : undefined;
    if (role !== undefined && role !== "") node.role = role;
    const name = typeof ax.name?.value === "string" ? ax.name.value.replace(/\s+/g, " ").trim() : undefined;
    if (name !== undefined && name !== "") node.name = name;
    const description =
      typeof ax.description?.value === "string" ? ax.description.value.replace(/\s+/g, " ").trim() : undefined;
    if (description !== undefined && description !== "") node.description = description;

    const state: Record<string, string | number | boolean | null> = {};
    for (const property of ax.properties ?? []) {
      if (!AX_STATE_PROPERTIES.has(property.name)) continue;
      const value = property.value?.value;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
        state[property.name] = value;
      }
    }
    if (Object.keys(state).length > 0) node.state = state;

    const reasons = (ax.ignoredReasons ?? []).map((property) => property.name).filter((n) => n !== "");
    if (reasons.length > 0) node.ignoredReasons = reasons;
    if (joined !== undefined) node.backendDomSourceId = joined.sourceId;

    (target.accessibilityNodes as CaptureAccessibilityNode[]).push(node);
  }

  const reasons = [...(options.healthReasons ?? []), ...partialReasons];
  const bundle: CaptureBundleReadProfile = {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    captureId: options.captureId,
    captureVersion: options.captureVersion,
    repository: { owner: options.repository.owner, name: options.repository.name },
    route: page.route,
    viewport: {
      widthCssPx: page.viewportWidthCssPx,
      heightCssPx: page.viewportHeightCssPx,
      deviceScaleFactor: page.deviceScaleFactor,
      scrollXCssPx: round2(page.scrollXCssPx),
      scrollYCssPx: round2(page.scrollYCssPx),
    },
    documents,
    pageHealth: {
      stable: options.stable,
      partial: partialReasons.length > 0,
      reasons,
    },
    redaction: {
      policyVersion: options.redactionPolicyVersion,
      applied: options.redactionApplied,
      redactedSourceIds,
    },
  };
  if (options.headSha !== undefined) bundle.headSha = options.headSha;
  if (options.screenshotEvidence !== undefined && options.screenshotEvidence.length > 0) {
    bundle.screenshotEvidence = [...options.screenshotEvidence];
  }
  return bundle;
}
