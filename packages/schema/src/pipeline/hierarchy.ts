/**
 * Pipeline stage 4: hierarchy + region builder (TRD §8.5, §5.6; PRD §6.1).
 *
 * Turns the flat fused candidates (#6) into the scene's structural skeleton and
 * its semantic regions:
 *  - **Hierarchy** by layout containment. Each node's parent is the smallest
 *    other node whose document rect encloses it; nodes without geometry attach
 *    to the smallest containing node (else a frame root).
 *  - **Regions**: landmark/form/list/table roles promote to `UIRegion`s, and
 *    repeated sibling patterns (a deterministic signature over role/kind/size)
 *    promote to `repeated` regions with a stable `repeatedPatternHash` and item
 *    counts.
 *  - **Node cap**: beyond `maxNodes`, repeated/low-salience regions are
 *    summarized and the truncation is reported; required hierarchy is never
 *    dropped, and the canonical set retains all nodes up to the cap.
 *
 * Deterministic: byte-identical fused input yields byte-identical hierarchy.
 */

import { createHash } from "node:crypto";
import type { Rect, UIRegion } from "../types.js";
import type { FusedNode } from "./fuse.js";
import { compareCodeUnits } from "../canonical.js";
import { warn, type PipelineIssue } from "./errors.js";

export interface NodeHierarchy {
  candidateId: string;
  parentNodeId?: string;
  regionIds: string[];
  depth: number;
}

export interface HierarchyTruncation {
  truncated: boolean;
  summarizedRegionIds: string[];
  omittedNodeCount: number;
}

export interface HierarchyResult {
  hierarchy: NodeHierarchy[];
  regions: UIRegion[];
  truncation: HierarchyTruncation;
  warnings: PipelineIssue[];
}

export interface HierarchyOptions {
  /** Canonical node cap; beyond it, repeated regions are summarized (TRD §16). */
  maxNodes?: number;
  /** Minimum repeats to form a `repeated` region (default 3). */
  repeatedRegionThreshold?: number;
}

const LANDMARK_ROLES = new Set(["navigation", "main", "banner", "contentinfo", "complementary", "region", "search"]);
const FORM_ROLES = new Set(["form"]);
const LIST_ROLES = new Set(["list", "listbox", "menu", "menubar"]);
const TABLE_ROLES = new Set(["table", "grid", "treegrid"]);

type RegionKind = UIRegion["kind"];

function regionKindForRole(role: string | undefined): RegionKind | null {
  if (role === undefined) return null;
  if (LANDMARK_ROLES.has(role)) return "landmark";
  if (FORM_ROLES.has(role)) return "form";
  if (LIST_ROLES.has(role)) return "list";
  if (TABLE_ROLES.has(role)) return "table";
  return null;
}

const area = (r: Rect): number => Math.max(0, r.width) * Math.max(0, r.height);

/** True when `outer` strictly encloses `inner`. */
function encloses(outer: Rect, inner: Rect): boolean {
  return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
}

function sizeBucket(n: number): number {
  return Math.round(n / 10) * 10;
}

/** Deterministic signature for repeated-region grouping (role / kind / size). */
function signatureOf(node: FusedNode): string {
  const g = node.geometry?.documentRect;
  const size = g !== undefined ? `${sizeBucket(g.width)}x${sizeBucket(g.height)}` : "na";
  return `${node.role?.value ?? "_"}|${node.kind}|${size}`;
}

function hashHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function buildHierarchy(nodes: readonly FusedNode[], options: HierarchyOptions = {}): HierarchyResult {
  const warnings: PipelineIssue[] = [];
  const threshold = options.repeatedRegionThreshold ?? 3;
  const sorted = [...nodes].sort((a, b) => compareCodeUnits(a.candidateId, b.candidateId));

  // (1) Parent assignment by smallest enclosing geometry (same frame).
  const parentOf = new Map<string, string | undefined>();
  for (const node of sorted) {
    const g = node.geometry?.documentRect;
    if (g === undefined) {
      parentOf.set(node.candidateId, undefined); // attached at frame root (no geometry to contain it)
      continue;
    }
    let best: FusedNode | undefined;
    for (const other of sorted) {
      if (other.candidateId === node.candidateId) continue;
      const og = other.geometry?.documentRect;
      if (og === undefined || other.frameId !== node.frameId) continue;
      if (encloses(og, g) && area(og) > area(g) && (best === undefined || area(og) < area(best.geometry!.documentRect))) {
        best = other;
      }
    }
    parentOf.set(node.candidateId, best?.candidateId);
  }

  // (2) Children index + depth.
  const childrenOf = new Map<string, string[]>();
  for (const node of sorted) {
    const p = parentOf.get(node.candidateId);
    if (p !== undefined) childrenOf.set(p, [...(childrenOf.get(p) ?? []), node.candidateId]);
  }
  const depthOf = new Map<string, number>();
  const computeDepth = (id: string): number => {
    const cached = depthOf.get(id);
    if (cached !== undefined) return cached;
    const p = parentOf.get(id);
    const d = p === undefined ? 0 : computeDepth(p) + 1;
    depthOf.set(id, d);
    return d;
  };
  for (const node of sorted) computeDepth(node.candidateId);

  const descendants = (id: string): string[] => {
    const out: string[] = [];
    const stack = [...(childrenOf.get(id) ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      out.push(cur);
      stack.push(...(childrenOf.get(cur) ?? []));
    }
    return out.sort();
  };

  const regions: UIRegion[] = [];

  // (3) Role-promoted regions (landmarks/forms/lists/tables).
  for (const node of sorted) {
    const kind = regionKindForRole(node.role?.value);
    if (kind === null) continue;
    const members = [node.candidateId, ...descendants(node.candidateId)];
    const region: UIRegion = {
      regionId: `reg_${hashHex(`${kind}:${node.candidateId}`)}`,
      rootNodeId: node.candidateId,
      kind,
      memberNodeIds: members,
      summary: kind === "list" || kind === "table" ? { itemCount: (childrenOf.get(node.candidateId) ?? []).length } : {},
      evidence: node.evidence,
      confidence: node.confidence,
    };
    if (node.name?.value !== undefined) region.label = node.name.value;
    regions.push(region);
  }

  // (4) Repeated-sibling regions (deterministic signature).
  const repeatedRegionIds: string[] = [];
  const parents = new Set<string | undefined>([...parentOf.values()]);
  for (const parent of [...parents].sort((a, b) => compareCodeUnits(a ?? "", b ?? ""))) {
    const siblings = sorted.filter((n) => parentOf.get(n.candidateId) === parent);
    const groups = new Map<string, FusedNode[]>();
    for (const s of siblings) groups.set(signatureOf(s), [...(groups.get(signatureOf(s)) ?? []), s]);
    for (const [signature, group] of [...groups.entries()].sort((a, b) => compareCodeUnits(a[0], b[0]))) {
      if (group.length < threshold) continue;
      const members = group.map((g) => g.candidateId).sort();
      const visible = group.filter((g) => g.geometry?.visibility === "visible" || g.geometry?.visibility === "clipped").length;
      const region: UIRegion = {
        regionId: `reg_rep_${hashHex(`${parent ?? "root"}:${signature}`)}`,
        rootNodeId: parent ?? members[0]!,
        kind: "repeated",
        memberNodeIds: members,
        summary: { itemCount: group.length, visibleItemCount: visible, repeatedPatternHash: digest(signature) },
        evidence: group[0]!.evidence,
        confidence: group[0]!.confidence,
      };
      regions.push(region);
      repeatedRegionIds.push(region.regionId);
    }
  }

  // (5) Node cap: summarize repeated regions only; never orphan retained hierarchy.
  const maxNodes = options.maxNodes;
  const omittedCandidateIds = new Set<string>();
  let truncation: HierarchyTruncation = { truncated: false, summarizedRegionIds: [], omittedNodeCount: 0 };
  if (maxNodes !== undefined && sorted.length > maxNodes) {
    const summarizedRegionIds: string[] = [];
    for (const id of repeatedRegionIds) {
      const region = regions.find((r) => r.regionId === id)!;
      let summarized = false;
      // Keep one representative. Omit whole sibling subtrees so no retained node
      // points at a parent that the canonical graph no longer contains.
      for (const member of region.memberNodeIds.slice(1)) {
        if (sorted.length - omittedCandidateIds.size <= maxNodes) break;
        for (const candidateId of [member, ...descendants(member)]) {
          omittedCandidateIds.add(candidateId);
        }
        summarized = true;
      }
      if (summarized) summarizedRegionIds.push(id);
      if (sorted.length - omittedCandidateIds.size <= maxNodes) break;
    }
    truncation = { truncated: true, summarizedRegionIds, omittedNodeCount: omittedCandidateIds.size };
    if (sorted.length - omittedCandidateIds.size > maxNodes) {
      warnings.push(warn("source_conflict", `node count ${sorted.length} exceeds maxNodes ${maxNodes} even after summarizing repeated regions`));
    }
  }

  const retainedIds = new Set(sorted.map((node) => node.candidateId).filter((id) => !omittedCandidateIds.has(id)));
  const retainedRegions = regions
    .filter((region) => retainedIds.has(region.rootNodeId))
    .map((region) => ({
      ...region,
      memberNodeIds: region.memberNodeIds.filter((member) => retainedIds.has(member)),
    }));

  // (6) regionIds per retained node.
  const regionsByNode = new Map<string, string[]>();
  for (const region of retainedRegions) {
    for (const member of region.memberNodeIds) {
      regionsByNode.set(member, [...(regionsByNode.get(member) ?? []), region.regionId]);
    }
  }

  const hierarchy: NodeHierarchy[] = sorted.filter((node) => retainedIds.has(node.candidateId)).map((node) => {
    const h: NodeHierarchy = { candidateId: node.candidateId, regionIds: (regionsByNode.get(node.candidateId) ?? []).sort(), depth: depthOf.get(node.candidateId) ?? 0 };
    const p = parentOf.get(node.candidateId);
    if (p !== undefined) h.parentNodeId = p;
    return h;
  });

  return { hierarchy, regions: retainedRegions, truncation, warnings };
}
