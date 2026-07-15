/**
 * Deterministic mutation chains behind the `ug-delta` manifest hashes
 * (#19 acceptance: "ug-delta fixtures carry canonical target hashes for
 * reconstruction tests"; TRD §15.2).
 *
 * Each step transforms a SEALED snapshot into the next sealed snapshot by a
 * named, pure mutation over the ref-free draft (the sealer re-derives refs,
 * hash, and id). The canonical target hash recorded in the manifest for a
 * step is the sealed `contentHash` after applying the chain up to that step —
 * so the manifest values are REAL, regenerable, and bound to the #14
 * encode/apply transport by the reconstruction test.
 *
 * Two properties the chains deliberately expose:
 *  - a pure sibling reorder is HASH-NEUTRAL (canonical collection ordering is
 *    part of snapshot identity — reordering is not a change);
 *  - every other mutation produces a distinct, reproducible hash.
 */

import { sealSnapshot } from "../canonical.js";
import type { UIGraphNode, UIGraphSnapshot, UIGraphSnapshotDraft } from "../types.js";

export type DeltaMutationKind =
  | "insert"
  | "reorder"
  | "text_edit"
  | "component_replace"
  | "responsive";

function draftOf(snapshot: UIGraphSnapshot): UIGraphSnapshotDraft {
  const { snapshotId: _i, contentHash: _h, nodes, ...semantic } = structuredClone(snapshot);
  return { ...semantic, nodes: nodes.map(({ elementRef: _r, ...node }) => node) } as UIGraphSnapshotDraft;
}

function cloneNode(base: UIGraphSnapshot, nodeId: string, dy: number): UIGraphSnapshotDraft["nodes"][number] {
  const { elementRef: _r, ...node } = structuredClone(base.nodes[0]!) as UIGraphNode;
  const copy = node as typeof node & { nodeId: string; geometry?: { documentRect?: { y: number }; viewportRect?: { y: number } } };
  copy.nodeId = nodeId;
  if (copy.geometry?.documentRect) copy.geometry.documentRect.y += dy;
  if (copy.geometry?.viewportRect) copy.geometry.viewportRect.y += dy;
  return copy;
}

/** Apply one named mutation step to a sealed snapshot; returns the next sealed snapshot. */
export function applyDeltaMutation(base: UIGraphSnapshot, fixtureId: string, label: string): UIGraphSnapshot {
  const draft = draftOf(base);
  switch (`${fixtureId}/${label}`) {
    // Every chain's baseline step is the (re-sealed) base itself.
    case "delta-insert-seq-01/baseline":
    case "delta-reorder-seq-01/baseline":
    case "delta-responsive-seq-01/baseline":
      break;
    case "delta-insert-seq-01/insert-header":
      draft.nodes = [...draft.nodes, cloneNode(base, "n_header", 40)];
      break;
    case "delta-insert-seq-01/insert-footer":
      draft.nodes = [...draft.nodes, cloneNode(base, "n_footer", 80)];
      break;
    case "delta-reorder-seq-01/reorder-nav":
      // Pure reorder: canonical ordering makes this HASH-NEUTRAL by design.
      draft.nodes = [...draft.nodes].reverse();
      break;
    case "delta-reorder-seq-01/edit-title": {
      const flagged = draft.nodes.map((node, index) =>
        index === 0 ? { ...node, flags: [...node.flags, "text_edited"] } : node,
      );
      draft.nodes = flagged;
      break;
    }
    case "delta-responsive-seq-01/replace-card": {
      const replaced = draft.nodes.map((node, index) =>
        index === 0 ? { ...node, flags: [...node.flags, "component_replaced"] } : node,
      );
      draft.nodes = replaced;
      break;
    }
    case "delta-responsive-seq-01/responsive-collapse": {
      const collapsed = draft.nodes.map((node, index) =>
        index === 0 ? { ...node, flags: [...node.flags, "responsive_collapsed"] } : node,
      );
      draft.nodes = collapsed;
      break;
    }
    default:
      throw new Error(`unknown ug-delta mutation step ${fixtureId}/${label}`);
  }
  return sealSnapshot(draft);
}

/** Sealed hash chain for a fixture's ordered step labels (cumulative). */
export function deltaChainHashes(
  base: UIGraphSnapshot,
  fixtureId: string,
  labels: readonly string[],
): Array<{ label: string; contentHash: string; snapshot: UIGraphSnapshot }> {
  let current = base;
  const out: Array<{ label: string; contentHash: string; snapshot: UIGraphSnapshot }> = [];
  for (const label of labels) {
    current = applyDeltaMutation(current, fixtureId, label);
    out.push({ label, contentHash: current.contentHash, snapshot: current });
  }
  return out;
}
