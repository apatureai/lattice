/**
 * The exact subset of the Chrome DevTools Protocol this adapter reads.
 *
 * Two commands carry everything lattice needs:
 *
 *  - `DOMSnapshot.captureSnapshot` returns the whole document tree, the layout
 *    tree (boxes, paint order, computed styles) and per-line text boxes in one
 *    round trip, string-interned. One call, no per-node protocol chatter.
 *  - `Accessibility.getFullAXTree` returns the accessibility tree with a
 *    `backendDOMNodeId` on every node that has a DOM element behind it.
 *
 * Both keyed by `backendNodeId`, which is why fusion in lattice can join them by
 * explicit id instead of falling back to geometric overlap, and why a DOM/AX
 * role disagreement lands as a retained conflict on ONE node rather than two
 * unrelated nodes (README, "Set backendDomSourceId wherever the protocol gives
 * it to you").
 *
 * These are structural types only. Nothing here imports a browser library, so
 * `transform.ts` can be unit-tested against a frozen protocol payload with no
 * browser installed.
 */

/** Index into the snapshot's shared string table. `-1` means "absent". */
export type StringIndex = number;

/** `[x, y, width, height]`, CSS pixels, document-relative for that frame. */
export type CdpRectangle = readonly number[];

/** CDP's sparse "only a few nodes have this" encoding. */
export interface CdpRareStringData {
  readonly index: readonly number[];
  readonly value: readonly StringIndex[];
}

export interface CdpRareBooleanData {
  readonly index: readonly number[];
}

export interface CdpRareIntegerData {
  readonly index: readonly number[];
  readonly value: readonly number[];
}

/** `DOMSnapshot.NodeTreeSnapshot`: one parallel array per field, node-indexed. */
export interface CdpNodeTreeSnapshot {
  readonly parentIndex?: readonly number[];
  readonly nodeType?: readonly number[];
  readonly nodeName?: readonly StringIndex[];
  readonly nodeValue?: readonly StringIndex[];
  readonly backendNodeId?: readonly number[];
  /** Per node: flat `[nameIndex, valueIndex, ...]`. */
  readonly attributes?: readonly (readonly StringIndex[])[];
  readonly contentDocumentIndex?: CdpRareIntegerData;
  readonly pseudoType?: CdpRareStringData;
  readonly isClickable?: CdpRareBooleanData;
  readonly inputValue?: CdpRareStringData;
  readonly inputChecked?: CdpRareBooleanData;
  readonly textValue?: CdpRareStringData;
}

/** `DOMSnapshot.LayoutTreeSnapshot`: layout-indexed, pointing back at nodes. */
export interface CdpLayoutTreeSnapshot {
  readonly nodeIndex?: readonly number[];
  /** Per layout node: string indices in the order of the requested `computedStyles`. */
  readonly styles?: readonly (readonly StringIndex[])[];
  readonly bounds?: readonly CdpRectangle[];
  readonly text?: readonly StringIndex[];
  readonly paintOrders?: readonly number[];
}

/** `DOMSnapshot.TextBoxSnapshot`: one entry per rendered line box. */
export interface CdpTextBoxSnapshot {
  readonly layoutIndex?: readonly number[];
  readonly bounds?: readonly CdpRectangle[];
  readonly start?: readonly number[];
  readonly length?: readonly number[];
}

export interface CdpDocumentSnapshot {
  readonly documentURL?: StringIndex;
  readonly frameId?: StringIndex;
  readonly nodes: CdpNodeTreeSnapshot;
  readonly layout: CdpLayoutTreeSnapshot;
  readonly textBoxes?: CdpTextBoxSnapshot;
  readonly scrollOffsetX?: number;
  readonly scrollOffsetY?: number;
  readonly contentWidth?: number;
  readonly contentHeight?: number;
}

/** The `DOMSnapshot.captureSnapshot` result. */
export interface CdpDomSnapshot {
  readonly documents: readonly CdpDocumentSnapshot[];
  readonly strings: readonly string[];
}

export interface CdpAxValue {
  readonly type?: string;
  readonly value?: unknown;
}

export interface CdpAxProperty {
  readonly name: string;
  readonly value?: CdpAxValue;
}

export interface CdpAxNode {
  readonly nodeId: string;
  readonly ignored: boolean;
  readonly ignoredReasons?: readonly CdpAxProperty[];
  readonly role?: CdpAxValue;
  readonly name?: CdpAxValue;
  readonly description?: CdpAxValue;
  readonly value?: CdpAxValue;
  readonly properties?: readonly CdpAxProperty[];
  readonly parentId?: string;
  readonly childIds?: readonly string[];
  readonly backendDOMNodeId?: number;
  readonly frameId?: string;
}

/** The `Accessibility.getFullAXTree` result. */
export interface CdpAxTree {
  readonly nodes: readonly CdpAxNode[];
}

/**
 * The minimum CDP surface `capture.ts` drives. Playwright's `CDPSession` and
 * puppeteer's satisfy it structurally, so neither library is imported here.
 */
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
