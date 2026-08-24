/**
 * The snapshot id must be a function of the page, not of the machine's locale.
 *
 * Every ordering decision the build path makes ends up in the content hash: the
 * order candidates are finalized in decides their ref ordinals, and the winner
 * of a tie between two competing claims is the value that gets sealed. If any
 * of those comparisons goes through `String.prototype.localeCompare`, the same
 * capture seals to a different `contentHash` under a different `LC_ALL` or a
 * different ICU build, which is exactly the property content addressing exists
 * to provide.
 *
 * The pair below is chosen so the two orderings disagree everywhere, not only
 * in some locales: "Z" is code unit 0x5A and "a" is 0x61, so code units put
 * "Zebra" first, while every collation puts the letter a before the letter z
 * regardless of case. The first assertion pins that the case still distinguishes
 * the two; if a future ICU makes them agree, this test says so rather than
 * quietly stopping to test anything.
 */

import { describe, expect, it } from "vitest";
import { buildUiGraph, compareCodeUnits, type CaptureBundleReadProfile } from "@apatureai/lattice";

const CODE_UNIT_FIRST = "Zebra";
const COLLATION_FIRST = "apple";

const BUILD_OPTIONS = {
  builderVersion: "ui-graph-builder@0.1.0",
  schemaVersion: "1.0.0",
  relationPolicyVersion: "relations@1",
  dnaProjectionVersion: "dna-projection@1",
  redactionPolicyVersion: "redaction@1",
  useMode: "offline_eval",
  maxNodes: 2000,
  maxPersistedEdgesPerNode: 8,
  repeatedRegionThreshold: 3,
  textPolicy: "truncate",
  includeHiddenExplanatoryNodes: false,
} as const;

/**
 * One element carrying two text runs of equal competence and equal confidence,
 * so nothing but the string comparison can break the tie.
 */
function captureWithTiedTextClaims(): CaptureBundleReadProfile {
  return {
    schemaVersion: "1.0.0",
    captureId: "capture_tied_text",
    captureVersion: "test-capture@1",
    repository: { owner: "apatureai", name: "example" },
    route: "/tied",
    viewport: {
      widthCssPx: 1440,
      heightCssPx: 900,
      deviceScaleFactor: 1,
      scrollXCssPx: 0,
      scrollYCssPx: 0,
    },
    documents: [
      {
        frameId: "main",
        url: "https://app.example.com/tied",
        domLayoutNodes: [
          {
            sourceId: "dom_0",
            frameId: "main",
            tag: "button",
            role: "button",
            bounds: { x: 10, y: 10, width: 120, height: 40 },
            visible: true,
          },
        ],
        accessibilityNodes: [
          {
            sourceId: "ax_0",
            frameId: "main",
            role: "button",
            name: "Submit",
            ignored: false,
            backendDomSourceId: "dom_0",
          },
        ],
        textRuns: [
          { sourceId: "txt_a", frameId: "main", text: COLLATION_FIRST, domSourceId: "dom_0" },
          { sourceId: "txt_z", frameId: "main", text: CODE_UNIT_FIRST, domSourceId: "dom_0" },
        ],
      },
    ],
    pageHealth: { stable: true, partial: false, reasons: [] },
    redaction: { policyVersion: "redaction@1", applied: false, redactedSourceIds: [] },
  } as CaptureBundleReadProfile;
}

describe("ordering on the hashed path is locale-independent", () => {
  it("uses a pair whose code-unit order and collation order really do disagree", () => {
    expect(compareCodeUnits(CODE_UNIT_FIRST, COLLATION_FIRST)).toBe(-1);
    expect(CODE_UNIT_FIRST.localeCompare(COLLATION_FIRST)).toBeGreaterThan(0);
  });

  it("breaks a tie between two claims by code unit, not by collation", async () => {
    const { snapshot } = await buildUiGraph({
      capture: captureWithTiedTextClaims(),
      options: { ...BUILD_OPTIONS },
    });

    const node = snapshot.nodes.find((n) => n.flags.includes("conflict:text"));
    expect(node).toBeDefined();
    // Collation ordering would seal "apple" here, and would seal a different
    // string again under a locale that sorts the two the other way round.
    expect(node!.semantics.text).toBe(CODE_UNIT_FIRST);
  });

  it("seals a content hash that does not move with the collation order", async () => {
    const { snapshot } = await buildUiGraph({
      capture: captureWithTiedTextClaims(),
      options: { ...BUILD_OPTIONS },
    });
    // Pinned: this capture contains the one string pair whose two orderings
    // disagree, so a comparison that consulted the locale would seal a
    // different hash here, and a different one again on a machine set to
    // sv-SE. Regenerate it only alongside a deliberate change to the sealed
    // shape, never to make a locale-sensitive comparison pass.
    expect(snapshot.contentHash).toBe(
      "sha256:a8dc8d6ac0240b533dceb22d0d55afaa226b88116fca752d4cf2493e10bf74f5",
    );
  });
});
