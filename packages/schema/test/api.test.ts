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

describe("remaining API stubs throw a typed not_implemented error", () => {
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
