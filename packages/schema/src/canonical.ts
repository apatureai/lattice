/**
 * Canonical serialization, RFC 8785 hashing, and content-addressed IDs.
 *
 * The graph is immutable after its content hash is assigned (TRD §2, §9). This
 * module produces a stable, content-addressed snapshot:
 *
 *  - `canonicalize` emits RFC 8785 (JCS) canonical JSON: UTF-8, lexicographic
 *    key ordering by UTF-16 code unit, ECMAScript `Number` serialization, and
 *    rejection of NaN/Infinity (TRD §9.1).
 *  - `computeRefScopeDigest` hashes the semantic snapshot with identity fields
 *    and element refs removed, breaking the ref/hash cycle (TRD §6.2).
 *  - `computeContentHash` hashes the snapshot with `snapshotId` and
 *    `contentHash` removed, after refs have been assigned (TRD §9.2).
 *  - `deriveSnapshotId` derives `ugs_1_*` from the content hash + schema major
 *    (TRD §6.1, §8.8).
 *  - `sealSnapshot` assigns refs and both snapshot identity fields, then
 *    validates their invariant and the normative schema (TRD §8.8, §19).
 *
 * Determinism contract: this module reads no wall-clock, randomness, or
 * locale-dependent formatting (enforced by the capability guard, issue #22).
 */

import { createHash } from "node:crypto";
import type {
  UIGraphNode,
  UIGraphSnapshot,
  UIGraphSnapshotDraft,
} from "./types.js";
import { formatErrors, validateSnapshot } from "./validate.js";

/** A JSON value with no `undefined`; canonicalization rejects non-finite numbers. */
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Serialize a value to RFC 8785 (JSON Canonicalization Scheme) form.
 *
 * Object keys are sorted by UTF-16 code unit (the JCS requirement, which is what
 * `String.prototype.localeCompare` is NOT; we use `<`/`>` on the raw strings to
 * stay locale-independent). `undefined` properties are dropped (optional fields
 * are omitted, not emitted as nulls, per TRD §9.1). NaN/Infinity throw.
 */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  writeCanonical(value, out);
  return out.join("");
}

function writeCanonical(value: unknown, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  const t = typeof value;
  if (t === "boolean") {
    out.push(value ? "true" : "false");
    return;
  }
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new Error(`canonicalize: non-finite number ${String(n)} is not permitted (TRD §9.1)`);
    }
    // ECMAScript Number->String is the RFC 8785 number production. `-0` must
    // serialize as `0` per JCS.
    out.push(Object.is(n, -0) ? "0" : String(n));
    return;
  }
  if (t === "string") {
    out.push(quoteString(value as string));
    return;
  }
  if (t === "undefined") {
    throw new Error("canonicalize: undefined is not a valid JSON value (TRD §9.1)");
  }
  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(",");
      const el = value[i];
      // Array element `undefined` would JSON.stringify to null; we forbid it so
      // callers cannot silently emit a meaningless null.
      if (el === undefined) {
        throw new Error("canonicalize: undefined array element is not permitted (TRD §9.1)");
      }
      writeCanonical(el, out);
    }
    out.push("]");
    return;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    // Sort keys by UTF-16 code unit. Drop keys whose value is undefined.
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort(compareCodeUnits);
    out.push("{");
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out.push(",");
      const k = keys[i] as string;
      out.push(quoteString(k));
      out.push(":");
      writeCanonical(obj[k], out);
    }
    out.push("}");
    return;
  }
  throw new Error(`canonicalize: unsupported value of type ${t}`);
}

/**
 * Lexicographic comparison by UTF-16 code unit, locale-independent.
 *
 * This is the only string ordering the library is allowed to use.
 * `String.prototype.localeCompare` resolves against the process locale, so the
 * same input sorts differently under a different `LC_ALL` or ICU build:
 * `["z", "ä"]` comes back `ä, z` under `en-US` and `z, ä` under `sv-SE`.
 * Anything that orders a collection on the way into a hash, a ref ordinal or a
 * rendered view therefore has to compare code units, or the snapshot id stops
 * being a function of the page alone. `scripts/capability-guard.mjs` fails the
 * build if `localeCompare` reappears anywhere in this package.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** RFC 8785 string escaping (the JSON minimal escape set). */
function quoteString(s: string): string {
  let result = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x08:
        result += "\\b";
        break;
      case 0x09:
        result += "\\t";
        break;
      case 0x0a:
        result += "\\n";
        break;
      case 0x0c:
        result += "\\f";
        break;
      case 0x0d:
        result += "\\r";
        break;
      case 0x22:
        result += '\\"';
        break;
      case 0x5c:
        result += "\\\\";
        break;
      default:
        if (c < 0x20) {
          result += "\\u" + c.toString(16).padStart(4, "0");
        } else {
          result += s[i];
        }
    }
  }
  return result + '"';
}

/** SHA-256 of a UTF-8 string, returned as `sha256:<hex>` (TRD §9.2). */
export function sha256(input: string): string {
  return "sha256:" + createHash("sha256").update(input, "utf8").digest("hex");
}

type SnapshotInput = UIGraphSnapshot | UIGraphSnapshotDraft;

/** Sort top-level id-addressed collections before assigning identity. */
function canonicalCollectionOrder<T extends SnapshotInput>(snapshot: T): T {
  return {
    ...snapshot,
    coordinateSpaces: [...snapshot.coordinateSpaces].sort((a, b) =>
      compareCodeUnits(a.coordinateSpaceId, b.coordinateSpaceId),
    ),
    nodes: [...snapshot.nodes].sort((a, b) => compareCodeUnits(a.nodeId, b.nodeId)),
    edges: [...snapshot.edges].sort((a, b) => compareCodeUnits(a.edgeId, b.edgeId)),
    regions: [...snapshot.regions].sort((a, b) =>
      compareCodeUnits(a.regionId, b.regionId),
    ),
  } as T;
}

/**
 * Acyclic scope digest for snapshot-local element refs (TRD §6.2).
 *
 * The projection excludes `snapshotId`, `contentHash`, and every `elementRef`.
 * Refs are derived from this digest, then included in the final content hash.
 * This is deliberately distinct from the final snapshot hash: deriving refs
 * from a hash that itself includes refs would require an accidental fixed point.
 */
export function computeRefScopeDigest(snapshot: SnapshotInput): string {
  const ordered = canonicalCollectionOrder(snapshot);
  const {
    contentHash: _contentHash,
    snapshotId: _snapshotId,
    nodes,
    ...semantic
  } = ordered;
  const refFreeNodes = nodes.map(({ elementRef: _elementRef, ...node }) => node);
  return sha256(
    canonicalize({ ...semantic, nodes: refFreeNodes } as unknown as JsonValue),
  );
}

/**
 * Content hash covering all semantic snapshot fields except `contentHash` and
 * `snapshotId` (TRD §9.2). The two excluded fields are stripped before
 * canonicalization so the hash is stable regardless of any placeholder values
 * already present.
 */
export function computeContentHash(snapshot: UIGraphSnapshot): string {
  const ordered = canonicalCollectionOrder(snapshot);
  const { contentHash: _c, snapshotId: _s, ...semantic } = ordered;
  return sha256(canonicalize(semantic as unknown as JsonValue));
}

/** Schema-major prefix for snapshot IDs, e.g. `ugs_1_` for schemaVersion 1.x.y. */
function snapshotIdPrefix(schemaVersion: string): string {
  const major = schemaVersion.split(".")[0] ?? "1";
  return `ugs_${major}_`;
}

/**
 * Derive `snapshotId` from the content hash + schema major (TRD §6.1, §8.8).
 * The schema pattern is `^ugs_1_[a-f0-9]{12,64}$`; we use the full 64-hex digest
 * so the ID is collision-resistant and content-addressed.
 */
export function deriveSnapshotId(snapshot: UIGraphSnapshot, contentHash: string): string {
  const hex = contentHash.replace(/^sha256:/, "");
  return snapshotIdPrefix(snapshot.schemaVersion) + hex;
}

/**
 * Element ref for a node ordinal within a snapshot (TRD §6.2):
 * `ug:<ref-scope-prefix>:<node-ordinal>`. The prefix is the first 8 hex chars of
 * the acyclic ref-scope digest. Authorization and stale-ref checks always bind
 * the ref to the full `(snapshotId, contentHash)` tuple; the short prefix alone
 * is not global authority.
 */
export function makeElementRef(refScopeDigest: string, ordinal: number): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(refScopeDigest)) {
    throw new Error("makeElementRef: ref-scope digest must be a sha256 digest");
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error("makeElementRef: ordinal must be a non-negative safe integer");
  }
  const hex = refScopeDigest.slice("sha256:".length);
  return `ug:${hex.slice(0, 8)}:${ordinal}`;
}

function assertUniqueNodeIds(nodes: SnapshotInput["nodes"]): void {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.nodeId)) {
      throw new Error(`sealSnapshot: duplicate nodeId ${node.nodeId}`);
    }
    ids.add(node.nodeId);
  }
}

function assignElementRefs(snapshot: SnapshotInput, refScopeDigest: string): UIGraphNode[] {
  assertUniqueNodeIds(snapshot.nodes);
  return snapshot.nodes.map((node, ordinal) => {
    const expected = makeElementRef(refScopeDigest, ordinal);
    if (node.elementRef !== undefined && node.elementRef !== expected) {
      throw new Error(
        `sealSnapshot: inconsistent elementRef for ${node.nodeId}; expected ${expected}`,
      );
    }
    return { ...node, elementRef: expected } as UIGraphNode;
  });
}

/**
 * Assert that refs, hash, and snapshot ID form one self-consistent identity.
 * Throws on stale, foreign, copied, duplicate, or otherwise corrupt refs.
 */
export function assertSnapshotIdentity(snapshot: UIGraphSnapshot): void {
  const ordered = canonicalCollectionOrder(snapshot);
  assertUniqueNodeIds(ordered.nodes);
  const scope = computeRefScopeDigest(ordered);
  const refs = new Set<string>();
  for (const [ordinal, node] of ordered.nodes.entries()) {
    const expected = makeElementRef(scope, ordinal);
    if (node.elementRef !== expected) {
      throw new Error(
        `snapshot identity: ${node.nodeId} has ${node.elementRef}; expected ${expected}`,
      );
    }
    if (refs.has(node.elementRef)) {
      throw new Error(`snapshot identity: duplicate elementRef ${node.elementRef}`);
    }
    refs.add(node.elementRef);
  }

  const expectedHash = computeContentHash(ordered);
  if (snapshot.contentHash !== expectedHash) {
    throw new Error(
      `snapshot identity: contentHash mismatch; expected ${expectedHash}`,
    );
  }
  const expectedId = deriveSnapshotId(ordered, expectedHash);
  if (snapshot.snapshotId !== expectedId) {
    throw new Error(`snapshot identity: snapshotId mismatch; expected ${expectedId}`);
  }
}

/**
 * Assign refs, `contentHash`, and `snapshotId`, then return a validated sealed
 * copy. A caller may omit all identity fields or pass an already sealed
 * snapshot. Supplied fields that do not match the recomputed identity fail
 * closed instead of silently surviving sealing.
 */
export function sealSnapshot(snapshot: SnapshotInput): UIGraphSnapshot {
  const ordered = canonicalCollectionOrder(snapshot);
  const refScopeDigest = computeRefScopeDigest(ordered);
  const nodes = assignElementRefs(ordered, refScopeDigest);
  const withRefs = { ...ordered, nodes } as UIGraphSnapshot;
  const contentHash = computeContentHash(withRefs);
  const snapshotId = deriveSnapshotId(withRefs, contentHash);

  if (snapshot.contentHash !== undefined && snapshot.contentHash !== contentHash) {
    throw new Error(`sealSnapshot: inconsistent contentHash; expected ${contentHash}`);
  }
  if (snapshot.snapshotId !== undefined && snapshot.snapshotId !== snapshotId) {
    throw new Error(`sealSnapshot: inconsistent snapshotId; expected ${snapshotId}`);
  }

  const sealed = { ...withRefs, contentHash, snapshotId };
  assertSnapshotIdentity(sealed);
  const validation = validateSnapshot(sealed);
  if (!validation.valid) {
    throw new Error(`sealSnapshot: schema validation failed: ${formatErrors(validation.errors)}`);
  }
  return sealed;
}
