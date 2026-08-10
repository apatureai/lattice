/**
 * In-memory fixtures for the validate + normalize pipeline tests. No real
 * capture, model, browser, or network: plain object literals only.
 */

import type { CaptureBundleReadProfile } from "@apature/ui-graph";

export function validCapture(
  overrides: Partial<CaptureBundleReadProfile> = {},
): CaptureBundleReadProfile {
  return {
    schemaVersion: "1.0.0",
    captureId: "cap_1",
    captureVersion: "1",
    repository: { owner: "acme", name: "web" },
    route: "/",
    viewport: {
      widthCssPx: 1000,
      heightCssPx: 800,
      deviceScaleFactor: 1,
      scrollXCssPx: 0,
      scrollYCssPx: 0,
    },
    documents: [
      {
        frameId: "root",
        domLayoutNodes: [
          {
            sourceId: "d1",
            frameId: "root",
            visible: true,
            bounds: { x: 0, y: 0, width: 100, height: 50 },
            styleFacts: { color: "#fff", backgroundColor: "rgb(0,0,0)", fontSizeCssPx: 16, padding: "1rem" },
          },
          {
            sourceId: "d2",
            parentSourceId: "d1",
            frameId: "root",
            visible: true,
            bounds: { x: 10, y: 10, width: 20, height: 20 },
          },
        ],
        accessibilityNodes: [{ sourceId: "a1", frameId: "root", ignored: false, backendDomSourceId: "d1" }],
        textRuns: [{ sourceId: "t1", frameId: "root", text: "  Hello  World ", bounds: { x: 0, y: 0, width: 80, height: 16 } }],
      },
    ],
    pageHealth: { stable: true, partial: false, reasons: [] },
    redaction: { policyVersion: "1", applied: false, redactedSourceIds: [] },
    ...overrides,
  };
}
