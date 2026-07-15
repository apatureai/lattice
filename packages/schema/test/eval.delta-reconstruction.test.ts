/**
 * #19's ug-delta acceptance bound to the live #14 transport: every manifest
 * step hash is regenerated from the canonical example snapshot via the real
 * sealer, and every step transition round-trips through
 * encodeUiGraphDelta/applyUiGraphDelta reproducing the recorded canonical
 * target hash exactly. A drifted manifest hash or a broken transport fails CI.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyUiGraphDelta,
  deltaChainHashes,
  encodeUiGraphDelta,
  REPRESENTATION_MANIFEST,
  type UIGraphSnapshot,
} from "../src/index.js";

const base = JSON.parse(
  readFileSync(fileURLToPath(new URL("./examples/minimal-snapshot.json", import.meta.url)), "utf8"),
) as UIGraphSnapshot;

const deltaSet = REPRESENTATION_MANIFEST.sets.find((s) => s.setId === "ug-delta");

describe("ug-delta canonical hashes are real and transport-bound (#19 × #14)", () => {
  it("every manifest step hash equals the live sealed chain hash", () => {
    expect(deltaSet).toBeDefined();
    for (const fixture of deltaSet!.fixtures) {
      const sequence = fixture.deltaSequence!;
      const live = deltaChainHashes(base, fixture.fixtureId, sequence.map((s) => s.label));
      for (const [index, step] of sequence.entries()) {
        expect(live[index]!.contentHash, `${fixture.fixtureId}/${step.label}`).toBe(step.canonicalTargetHash);
      }
    }
  });

  it("every step transition round-trips through encode/apply to the recorded hash", () => {
    for (const fixture of deltaSet!.fixtures) {
      const sequence = fixture.deltaSequence!;
      const live = deltaChainHashes(base, fixture.fixtureId, sequence.map((s) => s.label));
      let previous = live[0]!.snapshot;
      for (const step of live.slice(1)) {
        const delta = encodeUiGraphDelta(previous, step.snapshot);
        const rebuilt = applyUiGraphDelta(previous, delta);
        expect(rebuilt.contentHash).toBe(step.contentHash);
        previous = step.snapshot;
      }
    }
  });

  it("the reorder step is hash-neutral: canonical ordering means a pure reorder is not a change", () => {
    const reorder = deltaSet!.fixtures.find((f) => f.fixtureId === "delta-reorder-seq-01")!;
    const [baseline, reorderStep, editStep] = reorder.deltaSequence!;
    expect(reorderStep!.canonicalTargetHash).toBe(baseline!.canonicalTargetHash);
    expect(editStep!.canonicalTargetHash).not.toBe(baseline!.canonicalTargetHash);
  });
});
