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

const fakeSnapshot = {} as UIGraphSnapshot;
const fakeSpec = {} as UIGraphViewSpec;
const fakeDelta = {} as UIGraphDelta;

const buildRequest: BuildUiGraphRequest = {
  capture: { schemaVersion: "1.0.0", captureId: "c", captureVersion: "v" },
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

describe("API stubs throw a typed not_implemented error (issue #2)", () => {
  it("buildUiGraph rejects with not_implemented", async () => {
    await expect(buildUiGraph(buildRequest)).rejects.toMatchObject({
      code: "not_implemented",
    });
  });

  it("queryUiGraph throws not_implemented", () => {
    try {
      queryUiGraph({ snapshot: fakeSnapshot, spec: fakeSpec });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UIGraphError);
      expect((e as UIGraphError).code).toBe("not_implemented");
    }
  });

  it("diffUiGraphs throws not_implemented", () => {
    expect(() => diffUiGraphs(fakeSnapshot, fakeSnapshot)).toThrow(UIGraphError);
  });

  it("applyUiGraphDelta throws not_implemented", () => {
    expect(() => applyUiGraphDelta(fakeSnapshot, fakeDelta)).toThrow(UIGraphError);
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
