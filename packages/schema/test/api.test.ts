import { describe, it, expect } from "vitest";
import {
  buildUiGraph,
  queryUiGraph,
  diffUiGraphs,
  applyUiGraphDelta,
  UIGraphError,
  type BuildUiGraphRequest,
  type UIGraphSnapshot,
  type UIGraphViewSpec,
  type UIGraphDelta,
} from "@apature/ui-graph";
import { validCapture } from "./pipeline-fixtures.js";

const fakeSnapshot = {} as UIGraphSnapshot;
const fakeSpec = {} as UIGraphViewSpec;
const fakeDelta = {} as UIGraphDelta;

const buildRequest: BuildUiGraphRequest = {
  capture: validCapture(),
  options: {
    builderVersion: "ui-graph-builder@0.1.0",
    schemaVersion: "1.0.0",
    relationPolicyVersion: "relations@1",
    dnaProjectionVersion: "dna-projection@1",
    redactionPolicyVersion: "redaction@1",
    useMode: "shadow",
    maxNodes: 1000,
    maxPersistedEdgesPerNode: 16,
    repeatedRegionThreshold: 3,
    textPolicy: "truncate",
    includeHiddenExplanatoryNodes: false,
  },
};

describe("buildUiGraph public entry point (issue #9)", () => {
  it("builds a materialized capture through the public export", async () => {
    const result = await buildUiGraph(buildRequest);
    expect(result.snapshot.schemaVersion).toBe("1.0.0");
    expect(result.snapshot.nodes.length).toBeGreaterThan(0);
    expect(result.snapshot.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("every public entry point is implemented and fails closed", () => {
  it("queryUiGraph refuses an unsealed snapshot with a typed invalid_snapshot", () => {
    try {
      queryUiGraph({ snapshot: fakeSnapshot, spec: fakeSpec });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UIGraphError);
      // A stub would have said `not_implemented`; the dispatcher rejects the input.
      expect((e as UIGraphError).code).toBe("invalid_snapshot");
    }
  });

  it("diffUiGraphs is implemented (#13/#14): matches carried under both snapshot ids", () => {
    const empty = { ...fakeSnapshot, snapshotId: "ugs_x", nodes: [] } as UIGraphSnapshot;
    const diff = diffUiGraphs(empty, empty);
    expect(diff.baseSnapshotId).toBe("ugs_x");
    expect(diff.targetSnapshotId).toBe("ugs_x");
    expect(diff.matches).toEqual([]);
  });

  it("applyUiGraphDelta fails closed on an unbound base", () => {
    try {
      applyUiGraphDelta(fakeSnapshot, fakeDelta);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UIGraphError);
      // The empty delta is structurally invalid, so the binding is refused
      // before any operation is applied, so a typed error, never a partial result.
      expect((e as UIGraphError).code).toBe("invalid_delta");
    }
  });
});

describe("build options carry the experiment use mode (issue #23)", () => {
  it("accepts shadow / offline_eval / production modes", () => {
    const modes = ["shadow", "offline_eval", "production"] as const;
    for (const useMode of modes) {
      const req: BuildUiGraphRequest = {
        ...buildRequest,
        options: { ...buildRequest.options, useMode },
      };
      expect(req.options.useMode).toBe(useMode);
    }
  });
});
