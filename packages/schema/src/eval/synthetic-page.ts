/**
 * Deterministic synthetic capture evidence (no browser, no network).
 *
 * Everything else in this package consumes a `CaptureBundleReadProfile` that a
 * real browser capture would produce. This module manufactures one: a
 * page-shaped, realistically sized capture with landmarks, a repeated table, a
 * form, deliberate DOM/AX disagreement and a redacted field, so the library can
 * be built, queried and MEASURED end to end with nothing installed beyond Node.
 *
 * It is a fixture generator, not a renderer: no pixels exist, only the
 * structured observations a capture reports. Fully deterministic, so the same
 * options always produce a byte-identical capture, so a snapshot built from it
 * has a stable `contentHash` and any measurement taken over it is reproducible.
 *
 * Scale matters for honesty. The four golden fixtures in `test/fixtures/capture`
 * are 1 to 4 nodes, a size at which fixed per-view overhead swamps every ratio.
 * `syntheticCapture()` defaults to ~160 DOM nodes, which is where a page summary
 * has something to summarize.
 */

import type {
  CaptureAccessibilityNode,
  CaptureBundleReadProfile,
  CaptureDomLayoutNode,
  CaptureTextRun,
  UIDNAGraphProjectionReadProfile,
} from "../readprofile.js";
import type { Rect } from "../types.js";

export interface SyntheticPageOptions {
  readonly captureId?: string;
  readonly route?: string;
  readonly viewportWidthCssPx?: number;
  readonly viewportHeightCssPx?: number;
  /** Links in the header navigation landmark (default 6). */
  readonly navLinks?: number;
  /** Cards in the main content list (default 6). */
  readonly cards?: number;
  /** Rows in the repeated data table; each row emits three cells (default 24). */
  readonly tableRows?: number;
  /** Text inputs in the settings form (default 4). */
  readonly formFields?: number;
  /**
   * Give the primary call-to-action a DOM role of `link` and an accessibility
   * role of `button`, so fusion has a real conflict to retain (default true).
   */
  readonly roleConflict?: boolean;
  /** Mark the payment field's source id redacted upstream (default true). */
  readonly redactPaymentField?: boolean;
  /** Attach a screenshot evidence pointer (default true). No bytes are produced. */
  readonly screenshot?: boolean;
}

/** The screenshot artifact ref the generated capture points at. */
export const SYNTHETIC_SCREENSHOT_ARTIFACT_REF = "artifact://apature/synthetic-dashboard/root.png";

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

interface Builder {
  dom: CaptureDomLayoutNode[];
  ax: CaptureAccessibilityNode[];
  text: CaptureTextRun[];
}

function addDom(b: Builder, node: CaptureDomLayoutNode): string {
  b.dom.push(node);
  return node.sourceId;
}

function addAx(b: Builder, node: CaptureAccessibilityNode): void {
  b.ax.push(node);
}

function addText(b: Builder, sourceId: string, domSourceId: string, value: string, bounds: Rect): void {
  b.text.push({ sourceId, frameId: "root", domSourceId, text: value, bounds });
}

/**
 * Build a synthetic dashboard capture: header/nav landmark, main content with a
 * card list, a repeated table, a settings form, and a footer.
 */
export function syntheticCapture(options: SyntheticPageOptions = {}): CaptureBundleReadProfile {
  const width = options.viewportWidthCssPx ?? 1440;
  const height = options.viewportHeightCssPx ?? 900;
  const navLinks = options.navLinks ?? 6;
  const cards = options.cards ?? 6;
  const tableRows = options.tableRows ?? 24;
  const formFields = options.formFields ?? 4;
  const roleConflict = options.roleConflict ?? true;
  const redactPaymentField = options.redactPaymentField ?? true;
  const screenshot = options.screenshot ?? true;

  const b: Builder = { dom: [], ax: [], text: [] };

  // --- document root -------------------------------------------------------
  const body = addDom(b, {
    sourceId: "dom_body",
    frameId: "root",
    tag: "body",
    bounds: rect(0, 0, width, height),
    visible: true,
    paintOrder: 0,
    styleFacts: { backgroundColor: "#ffffff", fontFamily: "Inter", display: "block" },
  });
  addAx(b, { sourceId: "ax_body", frameId: "root", role: "document", ignored: false, backendDomSourceId: body });

  // --- header / navigation landmark ---------------------------------------
  const header = addDom(b, {
    sourceId: "dom_header",
    parentSourceId: body,
    frameId: "root",
    tag: "header",
    bounds: rect(0, 0, width, 72),
    visible: true,
    paintOrder: 1,
    styleFacts: { backgroundColor: "#0b1021", display: "flex", padding: "16px" },
  });
  addAx(b, { sourceId: "ax_header", frameId: "root", role: "banner", name: "Site header", ignored: false, backendDomSourceId: header });

  const brand = addDom(b, {
    sourceId: "dom_brand",
    parentSourceId: header,
    frameId: "root",
    tag: "a",
    attributes: { "data-testid": "brand", href: "/" },
    bounds: rect(24, 20, 132, 32),
    visible: true,
    paintOrder: 2,
  });
  addAx(b, { sourceId: "ax_brand", frameId: "root", role: "link", name: "Apature", ignored: false, backendDomSourceId: brand });
  addText(b, "txt_brand", brand, "Apature", rect(24, 26, 92, 20));

  const nav = addDom(b, {
    sourceId: "dom_nav",
    parentSourceId: header,
    frameId: "root",
    tag: "nav",
    bounds: rect(200, 20, 700, 32),
    visible: true,
    paintOrder: 3,
  });
  addAx(b, { sourceId: "ax_nav", frameId: "root", role: "navigation", name: "Primary", ignored: false, backendDomSourceId: nav });

  const navLabels = ["Overview", "Deployments", "Reviews", "Design system", "Insights", "Settings", "Billing", "Audit"];
  for (let i = 0; i < navLinks; i++) {
    const label = navLabels[i % navLabels.length]!;
    const id = addDom(b, {
      sourceId: `dom_nav_${i}`,
      parentSourceId: nav,
      frameId: "root",
      tag: "a",
      attributes: { "data-testid": `nav-${label.toLowerCase().replace(/\s+/g, "-")}`, href: `/${label.toLowerCase().replace(/\s+/g, "-")}` },
      bounds: rect(200 + i * 112, 24, 104, 24),
      visible: true,
      paintOrder: 4 + i,
      styleFacts: { color: "#c7d2fe", fontSizeCssPx: 14 },
    });
    addAx(b, { sourceId: `ax_nav_${i}`, frameId: "root", role: "link", name: label, ignored: false, backendDomSourceId: id });
    addText(b, `txt_nav_${i}`, id, label, rect(200 + i * 112, 28, 96, 16));
  }

  // The primary CTA: the one element where DOM and AX disagree on the role.
  const cta = addDom(b, {
    sourceId: "dom_cta",
    parentSourceId: header,
    frameId: "root",
    tag: "a",
    ...(roleConflict ? { role: "link" } : {}),
    attributes: { "data-testid": "new-review", id: "cta-new-review", href: "/reviews/new" },
    bounds: rect(1264, 18, 152, 36),
    visible: true,
    paintOrder: 20,
    // Off-scale radius and off-palette background: real DNA drift to find.
    styleFacts: { color: "#ffffff", backgroundColor: "#3b5bdb", fontSizeCssPx: 15, borderRadiusTopLeft: "7px", padding: "13px" },
  });
  addAx(b, { sourceId: "ax_cta", frameId: "root", role: "button", name: "New review", ignored: false, backendDomSourceId: cta });
  addText(b, "txt_cta", cta, "New review", rect(1280, 26, 120, 20));

  // --- main landmark -------------------------------------------------------
  const main = addDom(b, {
    sourceId: "dom_main",
    parentSourceId: body,
    frameId: "root",
    tag: "main",
    bounds: rect(0, 72, width, height - 132),
    visible: true,
    paintOrder: 21,
  });
  addAx(b, { sourceId: "ax_main", frameId: "root", role: "main", name: "Deployments", ignored: false, backendDomSourceId: main });

  const heading = addDom(b, {
    sourceId: "dom_h1",
    parentSourceId: main,
    frameId: "root",
    tag: "h1",
    bounds: rect(24, 96, 420, 40),
    visible: true,
    paintOrder: 22,
    styleFacts: { color: "#0b1021", fontSizeCssPx: 32, fontWeight: 700, lineHeightCssPx: 40 },
  });
  addAx(b, { sourceId: "ax_h1", frameId: "root", role: "heading", name: "Recent deployments", ignored: false, backendDomSourceId: heading, state: { level: 1 } });
  addText(b, "txt_h1", heading, "Recent deployments", rect(24, 102, 396, 32));

  // --- card list -----------------------------------------------------------
  const cardList = addDom(b, {
    sourceId: "dom_cardlist",
    parentSourceId: main,
    frameId: "root",
    tag: "ul",
    bounds: rect(24, 152, width - 48, 168),
    visible: true,
    paintOrder: 23,
  });
  addAx(b, { sourceId: "ax_cardlist", frameId: "root", role: "list", name: "Environments", ignored: false, backendDomSourceId: cardList });

  const cardNames = ["production", "staging", "preview", "canary", "sandbox", "edge", "eu-west", "ap-south"];
  for (let i = 0; i < cards; i++) {
    const name = cardNames[i % cardNames.length]!;
    const cardX = 24 + i * 228;
    const card = addDom(b, {
      sourceId: `dom_card_${i}`,
      parentSourceId: cardList,
      frameId: "root",
      tag: "li",
      bounds: rect(cardX, 152, 216, 168),
      visible: true,
      paintOrder: 24 + i * 2,
      styleFacts: { backgroundColor: "#f6f7fb", borderRadiusTopLeft: "8px", padding: "16px" },
    });
    addAx(b, { sourceId: `ax_card_${i}`, frameId: "root", role: "listitem", name: `${name} environment`, ignored: false, backendDomSourceId: card });
    const link = addDom(b, {
      sourceId: `dom_card_link_${i}`,
      parentSourceId: card,
      frameId: "root",
      tag: "a",
      attributes: { "data-testid": `env-link-${name}`, href: `/environments/${name}` },
      bounds: rect(cardX + 16, 268, 120, 24),
      visible: true,
      paintOrder: 25 + i * 2,
      styleFacts: { color: "#1b6ef3", fontSizeCssPx: 14 },
    });
    addAx(b, { sourceId: `ax_card_link_${i}`, frameId: "root", role: "link", name: `Open ${name}`, ignored: false, backendDomSourceId: link });
    addText(b, `txt_card_${i}`, card, `${name} · healthy`, rect(cardX + 16, 176, 184, 20));
  }

  // --- repeated table ------------------------------------------------------
  const tableTop = 336;
  const rowHeight = 28;
  const table = addDom(b, {
    sourceId: "dom_table",
    parentSourceId: main,
    frameId: "root",
    tag: "table",
    attributes: { "data-testid": "deploy-history" },
    bounds: rect(24, tableTop, width - 48, rowHeight * (tableRows + 1)),
    visible: true,
    paintOrder: 200,
  });
  addAx(b, { sourceId: "ax_table", frameId: "root", role: "table", name: "Deployment history", ignored: false, backendDomSourceId: table });

  const statuses = ["passed", "failed", "queued", "running"];
  for (let r = 0; r < tableRows; r++) {
    const rowY = tableTop + rowHeight * (r + 1);
    const row = addDom(b, {
      sourceId: `dom_row_${r}`,
      parentSourceId: table,
      frameId: "root",
      tag: "tr",
      attributes: { "data-testid": `deploy-row-${1000 + r}` },
      bounds: rect(24, rowY, width - 48, rowHeight),
      visible: true,
      paintOrder: 201 + r * 4,
    });
    addAx(b, { sourceId: `ax_row_${r}`, frameId: "root", role: "row", ignored: false, backendDomSourceId: row });
    const cellValues = [`#${1000 + r}`, `feat/branch-${r}`, statuses[r % statuses.length]!];
    for (let c = 0; c < cellValues.length; c++) {
      const cell = addDom(b, {
        sourceId: `dom_cell_${r}_${c}`,
        parentSourceId: row,
        frameId: "root",
        tag: "td",
        bounds: rect(24 + c * 448, rowY, 440, rowHeight),
        visible: true,
        paintOrder: 202 + r * 4 + c,
        styleFacts: { color: "#0b1021", fontSizeCssPx: 13 },
      });
      addAx(b, { sourceId: `ax_cell_${r}_${c}`, frameId: "root", role: "cell", name: cellValues[c]!, ignored: false, backendDomSourceId: cell });
      addText(b, `txt_cell_${r}_${c}`, cell, cellValues[c]!, rect(28 + c * 448, rowY + 4, 200, 18));
    }
  }

  // --- settings form -------------------------------------------------------
  const formTop = tableTop + rowHeight * (tableRows + 2);
  const form = addDom(b, {
    sourceId: "dom_form",
    parentSourceId: main,
    frameId: "root",
    tag: "form",
    bounds: rect(24, formTop, 640, 56 * (formFields + 2)),
    visible: true,
    paintOrder: 4000,
  });
  addAx(b, { sourceId: "ax_form", frameId: "root", role: "form", name: "Billing settings", ignored: false, backendDomSourceId: form });

  const fieldLabels = ["Team name", "Notification email", "Card number", "Billing address", "VAT id", "Slack channel"];
  const paymentFieldSourceId = "dom_field_2";
  for (let f = 0; f < formFields; f++) {
    const label = fieldLabels[f % fieldLabels.length]!;
    const fieldY = formTop + 16 + f * 56;
    const field = addDom(b, {
      sourceId: `dom_field_${f}`,
      parentSourceId: form,
      frameId: "root",
      tag: "input",
      attributes: { "data-testid": `field-${f}`, name: label.toLowerCase().replace(/\s+/g, "_") },
      bounds: rect(24, fieldY, 380, 40),
      visible: true,
      paintOrder: 4001 + f * 2,
      styleFacts: { backgroundColor: "#ffffff", fontSizeCssPx: 15, borderRadiusTopLeft: "6px", padding: "12px" },
    });
    addAx(b, {
      sourceId: `ax_field_${f}`,
      frameId: "root",
      role: "textbox",
      name: label,
      ignored: false,
      backendDomSourceId: field,
      state: { required: f === 0 },
    });
    addText(b, `txt_field_${f}`, field, label, rect(24, fieldY - 20, 200, 16));
  }

  const submit = addDom(b, {
    sourceId: "dom_submit",
    parentSourceId: form,
    frameId: "root",
    tag: "button",
    attributes: { "data-testid": "save-billing", id: "save-billing" },
    bounds: rect(24, formTop + 16 + formFields * 56, 168, 40),
    visible: true,
    paintOrder: 4500,
    styleFacts: { color: "#ffffff", backgroundColor: "#1b6ef3", fontSizeCssPx: 15, borderRadiusTopLeft: "6px", padding: "16px" },
  });
  addAx(b, { sourceId: "ax_submit", frameId: "root", role: "button", name: "Save billing settings", ignored: false, backendDomSourceId: submit });
  addText(b, "txt_submit", submit, "Save billing settings", rect(40, formTop + 26 + formFields * 56, 136, 20));

  // --- footer --------------------------------------------------------------
  const footer = addDom(b, {
    sourceId: "dom_footer",
    parentSourceId: body,
    frameId: "root",
    tag: "footer",
    bounds: rect(0, height - 60, width, 60),
    visible: true,
    paintOrder: 5000,
  });
  addAx(b, { sourceId: "ax_footer", frameId: "root", role: "contentinfo", name: "Footer", ignored: false, backendDomSourceId: footer });
  addText(b, "txt_footer", footer, "Apature — archived", rect(24, height - 40, 240, 20));

  const redactedSourceIds =
    redactPaymentField && b.dom.some((n) => n.sourceId === paymentFieldSourceId) ? [paymentFieldSourceId] : [];

  return {
    schemaVersion: "1.0.0",
    captureId: options.captureId ?? "cap_synthetic_dashboard",
    captureVersion: "synthetic-capture@1",
    repository: { owner: "apatureai", name: "ui-graph" },
    route: options.route ?? "/deployments",
    headSha: "0000000000000000000000000000000000000000",
    viewport: {
      widthCssPx: width,
      heightCssPx: height,
      deviceScaleFactor: 2,
      scrollXCssPx: 0,
      scrollYCssPx: 0,
    },
    documents: [
      {
        frameId: "root",
        url: "https://example.invalid/deployments",
        domLayoutNodes: b.dom,
        accessibilityNodes: b.ax,
        textRuns: b.text,
      },
    ],
    ...(screenshot
      ? {
          screenshotEvidence: [
            {
              artifactRef: SYNTHETIC_SCREENSHOT_ARTIFACT_REF,
              frameId: "root",
              widthImagePx: width * 2,
              heightImagePx: height * 2,
              deviceScaleFactor: 2,
            },
          ],
        }
      : {}),
    pageHealth: { stable: true, partial: false, reasons: [] },
    redaction: { policyVersion: "redaction@1", applied: true, redactedSourceIds },
  };
}

/**
 * A small approved design system to project onto the synthetic page: the brand
 * blue, a 4px spacing scale, an 8px radius and a type scale. The generated page
 * deliberately drifts from several of these (an off-palette CTA background, a
 * 7px radius, 13px padding), so `violations` has real findings to rank.
 */
export function syntheticDna(): UIDNAGraphProjectionReadProfile {
  return {
    projectionSchemaVersion: "1.0.0",
    dnaVersion: "synthetic-dna@1",
    dnaContentDigest: "sha256:5b1f2e2f2b7a4c9d8e6f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f",
    state: "approved",
    tokens: {
      "color.brand": { value: "#1b6ef3", category: "color", confidence: 0.99 },
      "color.ink": { value: "#0b1021", category: "color", confidence: 0.99 },
      "color.surface": { value: "#ffffff", category: "color", confidence: 0.99 },
      "color.surfaceMuted": { value: "#f6f7fb", category: "color", confidence: 0.95 },
      "color.onBrand": { value: "#ffffff", category: "color", confidence: 0.99 },
      "space.sm": { value: 8, category: "spacing", confidence: 0.97 },
      "space.md": { value: 12, category: "spacing", confidence: 0.97 },
      "space.lg": { value: 16, category: "spacing", confidence: 0.97 },
      "radius.md": { value: 8, category: "radii", confidence: 0.96 },
      "type.body": { value: 14, category: "typography", confidence: 0.95 },
      "type.control": { value: 15, category: "typography", confidence: 0.95 },
      "type.display": { value: 32, category: "typography", confidence: 0.95 },
    },
    semanticRoles: [],
    componentFamilies: [],
    distributions: [],
    rules: [],
    exceptions: [],
    contexts: [],
  };
}
