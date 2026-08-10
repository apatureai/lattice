/**
 * Frozen representation fixture DATA for the six internal eval sets (issue #19,
 * PRD §8.1). This is the source-of-truth manifest content a consumer's eval
 * harness (#20) and the promotion gate (#24) measure against.
 *
 * Everything here is MOCK: synthetic captures fabricated for deterministic
 * evaluation, never a real model/browser/network artifact. `captureRef` values
 * point at the golden read-profile fixtures frozen by issue #3 (resolved by the
 * harness); each entry records the full provenance PRD §8.1 requires.
 *
 * The manifest is sealed once at module load via `freezeManifest`, so the
 * content hashes are frozen and any drift is caught by `verifyManifest`.
 */

import type { Viewport } from "../types.js";
import {
  freezeManifest,
  type EvalCohort,
  type FixtureEntry,
  type FixtureLicense,
  type FixtureSetId,
  type RepresentationManifest,
  type UnsealedFixtureSet,
} from "./manifest.js";

// Version stamps shared by the synthetic set (one frozen provenance baseline).
const CAPTURE_VERSION = "playwright-capture@3";
const BROWSER_VERSION = "chromium@120.0.6099.109";
const BUILDER_VERSION = "ui-graph-builder@0.1.0";
const DNA_VERSION = "ui-dna@1.0.0";
const REDACTION_POLICY = "redaction@1";

const DESKTOP: Viewport = {
  widthCssPx: 1440,
  heightCssPx: 900,
  deviceScaleFactor: 2,
  scrollXCssPx: 0,
  scrollYCssPx: 0,
};

const MOBILE: Viewport = {
  widthCssPx: 390,
  heightCssPx: 844,
  deviceScaleFactor: 3,
  scrollXCssPx: 0,
  scrollYCssPx: 0,
};

const SYNTHETIC: FixtureLicense = { spdx: "synthetic", consent: "synthetic" };

type Unsealed = Omit<FixtureEntry, "contentHash">;

/** Build a fixture entry with the shared provenance baseline; overridable. */
function fixture(args: {
  fixtureId: string;
  setId: FixtureSetId;
  title: string;
  cohorts: readonly EvalCohort[];
  captureRef: string;
  viewport?: Viewport;
  license?: FixtureLicense;
  deltaSequence?: Unsealed["deltaSequence"];
}): Unsealed {
  const entry: Unsealed = {
    fixtureId: args.fixtureId,
    setId: args.setId,
    title: args.title,
    cohorts: args.cohorts,
    captureRef: args.captureRef,
    provenance: {
      captureVersion: CAPTURE_VERSION,
      browserVersion: BROWSER_VERSION,
      viewport: args.viewport ?? DESKTOP,
      graphBuilderVersion: BUILDER_VERSION,
      uiDnaVersion: DNA_VERSION,
      redactionPolicyVersion: REDACTION_POLICY,
      license: args.license ?? SYNTHETIC,
    },
  };
  if (args.deltaSequence !== undefined) {
    (entry as { deltaSequence?: Unsealed["deltaSequence"] }).deltaSequence = args.deltaSequence;
  }
  return entry;
}

// REAL canonical target hashes for the ug-delta reconstruction tests (#14/#19):
// each value is the sealed contentHash after applying the fixture's cumulative
// mutation chain (eval/delta-mutations.ts) to the canonical example snapshot.
// eval.delta-reconstruction.test.ts regenerates every chain via the live
// sealer AND round-trips it through encodeUiGraphDelta/applyUiGraphDelta, so a
// drifted hash fails CI. The reorder step deliberately equals its baseline:
// canonical collection ordering makes a pure sibling reorder hash-neutral.

const UNSEALED_SETS: readonly UnsealedFixtureSet[] = [
  {
    setId: "ug-core",
    description:
      "Representative routes across clean, drifted, responsive, dense, and long-page layouts (PRD §8.1).",
    fixtures: [
      fixture({ fixtureId: "core-clean-01", setId: "ug-core", title: "Clean document root", cohorts: ["clean"], captureRef: "capture/minimal.json" }),
      fixture({ fixtureId: "core-drifted-01", setId: "ug-core", title: "Drifted spacing/token layout", cohorts: ["drifted"], captureRef: "capture/minimal.json" }),
      fixture({ fixtureId: "core-responsive-01", setId: "ug-core", title: "Responsive mobile viewport", cohorts: ["responsive"], captureRef: "capture/minimal.json", viewport: MOBILE }),
      fixture({ fixtureId: "core-dense-01", setId: "ug-core", title: "Dense multi-frame layout", cohorts: ["dense"], captureRef: "capture/multi-frame.json" }),
      fixture({ fixtureId: "core-longpage-01", setId: "ug-core", title: "Long scrolling page", cohorts: ["long_page"], captureRef: "capture/minimal.json" }),
    ],
  },
  {
    setId: "ug-lineage",
    description:
      "Before/after captures: insertions, reorderings, text edits, component replacement, responsive changes (PRD §8.1).",
    fixtures: [
      fixture({ fixtureId: "lineage-insert-01", setId: "ug-lineage", title: "Node insertion before/after", cohorts: ["clean"], captureRef: "capture/minimal.json" }),
      fixture({ fixtureId: "lineage-reorder-01", setId: "ug-lineage", title: "Sibling reordering", cohorts: ["clean"], captureRef: "capture/multi-frame.json" }),
      fixture({ fixtureId: "lineage-textedit-01", setId: "ug-lineage", title: "Text edit only", cohorts: ["clean"], captureRef: "capture/minimal.json" }),
      fixture({ fixtureId: "lineage-replace-01", setId: "ug-lineage", title: "Component replacement", cohorts: ["drifted"], captureRef: "capture/multi-frame.json" }),
      fixture({ fixtureId: "lineage-responsive-01", setId: "ug-lineage", title: "Responsive reflow", cohorts: ["responsive"], captureRef: "capture/minimal.json", viewport: MOBILE }),
    ],
  },
  {
    setId: "ug-nondom",
    description:
      "Canvas, SVG, image-only, shadow-heavy, and custom-control screens with optional parser observations (PRD §8.1).",
    fixtures: [
      fixture({ fixtureId: "nondom-canvas-01", setId: "ug-nondom", title: "Canvas-only with parser obs", cohorts: ["non_dom"], captureRef: "capture/with-derived.json" }),
      fixture({ fixtureId: "nondom-svg-01", setId: "ug-nondom", title: "SVG-heavy screen", cohorts: ["non_dom"], captureRef: "capture/with-derived.json" }),
      fixture({ fixtureId: "nondom-imageonly-01", setId: "ug-nondom", title: "Image-only screen (OCR)", cohorts: ["non_dom"], captureRef: "capture/with-derived.json" }),
      fixture({ fixtureId: "nondom-shadow-01", setId: "ug-nondom", title: "Shadow-DOM-heavy widget", cohorts: ["non_dom", "dense"], captureRef: "capture/multi-frame.json" }),
      fixture({ fixtureId: "nondom-customctl-01", setId: "ug-nondom", title: "Custom non-native controls", cohorts: ["non_dom"], captureRef: "capture/with-derived.json" }),
    ],
  },
  {
    setId: "ug-dna",
    description:
      "Exact token matches, tolerance matches, intentional exceptions, ambiguous families, and unapproved DNA (PRD §8.1).",
    fixtures: [
      fixture({ fixtureId: "dna-exact-01", setId: "ug-dna", title: "Exact token match", cohorts: ["clean"], captureRef: "capture/minimal.json" }),
      fixture({ fixtureId: "dna-tolerance-01", setId: "ug-dna", title: "Within-tolerance numeric match", cohorts: ["clean"], captureRef: "capture/minimal.json" }),
      fixture({ fixtureId: "dna-exception-01", setId: "ug-dna", title: "Intentional approved exception", cohorts: ["drifted"], captureRef: "capture/minimal.json" }),
      fixture({ fixtureId: "dna-ambiguous-01", setId: "ug-dna", title: "Ambiguous component family", cohorts: ["drifted"], captureRef: "capture/multi-frame.json" }),
      fixture({ fixtureId: "dna-unapproved-01", setId: "ug-dna", title: "Unapproved DNA (shadow-only)", cohorts: ["drifted"], captureRef: "capture/minimal.json" }),
    ],
  },
  {
    setId: "ug-security",
    description:
      "Hidden text, visual prompt injection, oversized content, PII, malicious labels, and cross-tenant refs (PRD §8.1).",
    fixtures: [
      fixture({ fixtureId: "security-hiddentext-01", setId: "ug-security", title: "Hidden off-screen text", cohorts: ["injection"], captureRef: "capture/minimal.json" }),
      fixture({ fixtureId: "security-injection-01", setId: "ug-security", title: "Visual prompt injection label", cohorts: ["injection"], captureRef: "capture/with-derived.json" }),
      fixture({ fixtureId: "security-oversized-01", setId: "ug-security", title: "Oversized content flood", cohorts: ["injection", "dense"], captureRef: "capture/multi-frame.json" }),
      fixture({ fixtureId: "security-pii-01", setId: "ug-security", title: "PII requiring redaction", cohorts: ["pii"], captureRef: "capture/minimal.json" }),
      fixture({ fixtureId: "security-maliciouslabel-01", setId: "ug-security", title: "Malicious accessible label", cohorts: ["injection"], captureRef: "capture/minimal.json" }),
      fixture({ fixtureId: "security-crosstenant-01", setId: "ug-security", title: "Cross-tenant ref attempt", cohorts: ["cross_tenant"], captureRef: "capture/multi-frame.json" }),
    ],
  },
  {
    setId: "ug-delta",
    description:
      "Mutation sequences with canonical target hashes for reconstruction tests (PRD §8.1, TRD §15.2).",
    fixtures: [
      fixture({
        fixtureId: "delta-insert-seq-01",
        setId: "ug-delta",
        title: "Insertion sequence",
        cohorts: ["clean"],
        captureRef: "capture/minimal.json",
        deltaSequence: [
          { label: "baseline", mutation: "insert", canonicalTargetHash: "sha256:d7c4d35428a785194bb3932dafd0e533503450cf87cd384bd9b05ebd503e6696" },
          { label: "insert-header", mutation: "insert", canonicalTargetHash: "sha256:83635f6e7a798bb27360f5060bd580b4653f330e361c0a7ca2eb85efd0d5a2f3" },
          { label: "insert-footer", mutation: "insert", canonicalTargetHash: "sha256:9f8cdec4d35eef812c864f6fc9f951badb5e5ac1841af3e4cf7dbc30b2ba3ce8" },
        ],
      }),
      fixture({
        fixtureId: "delta-reorder-seq-01",
        setId: "ug-delta",
        title: "Reorder + text-edit sequence",
        cohorts: ["clean"],
        captureRef: "capture/multi-frame.json",
        deltaSequence: [
          { label: "baseline", mutation: "reorder", canonicalTargetHash: "sha256:d7c4d35428a785194bb3932dafd0e533503450cf87cd384bd9b05ebd503e6696" },
          { label: "reorder-nav", mutation: "reorder", canonicalTargetHash: "sha256:d7c4d35428a785194bb3932dafd0e533503450cf87cd384bd9b05ebd503e6696" },
          { label: "edit-title", mutation: "text_edit", canonicalTargetHash: "sha256:64a656d313340ddef4a6fb64ddb40434f93973c58f39d19b087145af86aa12be" },
        ],
      }),
      fixture({
        fixtureId: "delta-responsive-seq-01",
        setId: "ug-delta",
        title: "Component replace + responsive sequence",
        cohorts: ["responsive"],
        captureRef: "capture/minimal.json",
        viewport: MOBILE,
        deltaSequence: [
          { label: "baseline", mutation: "component_replace", canonicalTargetHash: "sha256:d7c4d35428a785194bb3932dafd0e533503450cf87cd384bd9b05ebd503e6696" },
          { label: "replace-card", mutation: "component_replace", canonicalTargetHash: "sha256:bcb7e960e6ddbffe794965b7c40bd5a75b0f76dccea6abca8e7f9b1aab3535be" },
          { label: "responsive-collapse", mutation: "responsive", canonicalTargetHash: "sha256:78380306a74f04076535a711b544cfa15ee55651c7ac11669a4674b619d69cf3" },
        ],
      }),
    ],
  },
];

/** The frozen, content-addressed representation manifest (issue #19). */
export const REPRESENTATION_MANIFEST: RepresentationManifest = freezeManifest(UNSEALED_SETS);
