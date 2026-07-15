/**
 * #14 acceptance: typed ID-keyed delta transport with fail-closed integrity
 * (TRD §12, ADR-008). Encode base→target, apply to a verified base, and the
 * reconstructed target must re-seal to EXACTLY the declared identity — every
 * mismatch, malformed op, dangling reference, or adversarial mutation rejects
 * whole with no partial result.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyUiGraphDelta,
  encodeUiGraphDelta,
  sealSnapshot,
  UIGraphError,
  type UIGraphDelta,
  type UIGraphSnapshot,
} from "../src/index.js";

const sealed = JSON.parse(
  readFileSync(fileURLToPath(new URL("./examples/minimal-snapshot.json", import.meta.url)), "utf8"),
) as UIGraphSnapshot;

/** Reseal a structural variant of the base (adds a node + warning). */
function variantTarget(): UIGraphSnapshot {
  const { snapshotId: _i, contentHash: _h, nodes, ...semantic } = structuredClone(sealed);
  const bare = nodes.map(({ elementRef: _r, ...node }) => node);
  const clone = structuredClone(bare[0]!) as (typeof bare)[0] & { nodeId: string };
  clone.nodeId = `${clone.nodeId}_v2`;
  return sealSnapshot({
    ...semantic,
    nodes: [...bare, clone],
    warnings: [...semantic.warnings],
  } as Parameters<typeof sealSnapshot>[0]);
}

describe("delta encode/apply round trip (#14)", () => {
  const target = variantTarget();
  const delta = encodeUiGraphDelta(sealed, target);

  it("reconstruction hash-matches 100%: apply(base, encode(base, target)) === target", () => {
    const rebuilt = applyUiGraphDelta(sealed, delta);
    expect(rebuilt.snapshotId).toBe(target.snapshotId);
    expect(rebuilt.contentHash).toBe(target.contentHash);
    expect(rebuilt).toEqual(target);
  });

  it("the delta binds full identity tuples and is content-addressed + deterministic", () => {
    expect(delta.baseSnapshotId).toBe(sealed.snapshotId);
    expect(delta.baseContentHash).toBe(sealed.contentHash);
    expect(delta.targetSnapshotId).toBe(target.snapshotId);
    expect(delta.targetContentHash).toBe(target.contentHash);
    expect(encodeUiGraphDelta(sealed, variantTarget())).toEqual(delta); // same inputs → same delta id
  });

  it("an identity delta (base → base) is empty and still round-trips", () => {
    const identity = encodeUiGraphDelta(sealed, sealed);
    expect(identity.operations).toEqual([]);
    expect(applyUiGraphDelta(sealed, identity)).toEqual(sealed);
  });

  it("base mismatch rejects entirely (delta_base_mismatch), no partial target", () => {
    const foreign = { ...delta, baseContentHash: delta.baseContentHash.slice(0, -1) + "f" };
    try {
      applyUiGraphDelta(sealed, foreign as UIGraphDelta);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as UIGraphError).code).toBe("delta_base_mismatch");
    }
  });

  it("an adversarial delta cannot produce a hash-valid snapshot (target identity forged)", () => {
    const forged = { ...delta, targetContentHash: "sha256:" + "0".repeat(64) };
    try {
      applyUiGraphDelta(sealed, forged as UIGraphDelta);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as UIGraphError).code).toBe("invalid_delta");
    }
  });

  it("mutated operations reject: the reconstructed snapshot no longer matches the declared target", () => {
    const mutated = structuredClone(delta);
    const upsert = mutated.operations.find((o) => o.op === "upsert_node");
    expect(upsert).toBeDefined();
    if (upsert && upsert.op === "upsert_node") (upsert.node as { kind: string }).kind = "text";
    expect(() => applyUiGraphDelta(sealed, mutated)).toThrow(UIGraphError);
  });

  it("node removal never cascades: a dangling incident edge rejects the whole delta", () => {
    // Build a base with one edge, then a delta that removes the node WITHOUT
    // removing the edge — must reject, not silently drop the edge.
    const { snapshotId: _i, contentHash: _h, nodes, ...semantic } = structuredClone(sealed);
    const bare = nodes.map(({ elementRef: _r, ...node }) => node);
    const second = structuredClone(bare[0]!) as (typeof bare)[0] & { nodeId: string };
    second.nodeId = `${second.nodeId}_b`;
    const withEdge = sealSnapshot({
      ...semantic,
      nodes: [...bare, second],
      edges: [
        {
          edgeId: "e_delta_test_1",
          kind: "contains",
          fromNodeId: bare[0]!.nodeId,
          toNodeId: second.nodeId,
          directed: true,
          weight: 1,
          attributes: {},
          evidence: [
            { sourceType: "layout", sourceId: "document_0", coordinateSpaceId: "viewport", confidence: 1, claims: ["geometry"] },
          ],
        },
      ],
    } as unknown as Parameters<typeof sealSnapshot>[0]);

    const bad: UIGraphDelta = {
      ...encodeUiGraphDelta(withEdge, withEdge),
      operations: [{ op: "remove_node", nodeId: second.nodeId }],
    };
    try {
      applyUiGraphDelta(withEdge, bad);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as UIGraphError).code).toBe("invalid_delta");
      expect((e as UIGraphError).message).toContain("incident edge");
    }
  });

  it("removals of nonexistent ids and unsupported schema versions reject", () => {
    const ghost: UIGraphDelta = { ...delta, operations: [{ op: "remove_node", nodeId: "ghost" }] };
    expect(() => applyUiGraphDelta(sealed, ghost)).toThrow(UIGraphError);
    const wrongVersion = { ...delta, schemaVersion: "ui-graph/999" as UIGraphDelta["schemaVersion"] };
    try {
      applyUiGraphDelta(sealed, wrongVersion);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as UIGraphError).code).toBe("invalid_delta");
    }
  });
});
