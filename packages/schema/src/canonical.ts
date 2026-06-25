/**
 * Canonical serialization, RFC 8785 hashing, and content-addressed IDs.
 *
 * The graph is immutable after its content hash is assigned (TRD §2, §9). This
 * module produces a stable, content-addressed snapshot:
 *
 *  - `canonicalize` emits RFC 8785 (JCS) canonical JSON: UTF-8, lexicographic
 *    key ordering by UTF-16 code unit, ECMAScript `Number` serialization, and
 *    rejection of NaN/Infinity (TRD §9.1).
 *  - `computeContentHash` hashes the snapshot with `snapshotId` and
 *    `contentHash` removed (TRD §9.2).
 *  - `deriveSnapshotId` derives `ugs_1_*` from the content hash + schema major
 *    (TRD §6.1, §8.8).
 *  - `sealSnapshot` assigns both and is deterministic for byte-identical
 *    semantic input (TRD §15.2, §19).
 *
 * Determinism contract: this module reads no wall-clock, randomness, or
 * locale-dependent formatting (enforced by the capability guard, issue #22).
 */

import { createHash } from "node:crypto";
import type { UIGraphSnapshot } from "./types.js";

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
 * `String.prototype.localeCompare` is NOT — we use `<`/`>` on the raw strings to
 * stay locale-independent). `undefined` properties are dropped (optional fields
 * are omitted, not emitted as nulls — TRD §9.1). NaN/Infinity throw.
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

/** Lexicographic comparison by UTF-16 code unit, locale-independent. */
function compareCodeUnits(a: string, b: string): number {
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

/**
 * Content hash covering all semantic snapshot fields except `contentHash` and
 * `snapshotId` (TRD §9.2). The two excluded fields are stripped before
 * canonicalization so the hash is stable regardless of any placeholder values
 * already present.
 */
export function computeContentHash(snapshot: UIGraphSnapshot): string {
  const { contentHash: _c, snapshotId: _s, ...semantic } = snapshot;
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
 * `ug:<snapshot-prefix>:<node-ordinal>`. The prefix is the first 8 hex chars of
 * the content hash — enough to scope refs to one snapshot and reject foreign
 * refs, with no semantic promise in the ordinal.
 */
export function makeElementRef(contentHash: string, ordinal: number): string {
  const hex = contentHash.replace(/^sha256:/, "");
  return `ug:${hex.slice(0, 8)}:${ordinal}`;
}

/**
 * Assign `contentHash` then `snapshotId` to a snapshot and return the sealed,
 * immutable copy. Deterministic for byte-identical semantic input.
 *
 * Note: `snapshotId` is intentionally excluded from the hash, so assigning it
 * after the hash does not change the hash (TRD §9.2).
 */
export function sealSnapshot(snapshot: UIGraphSnapshot): UIGraphSnapshot {
  const contentHash = computeContentHash(snapshot);
  const snapshotId = deriveSnapshotId(snapshot, contentHash);
  return { ...snapshot, contentHash, snapshotId };
}
