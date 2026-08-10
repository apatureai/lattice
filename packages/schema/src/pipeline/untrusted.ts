/**
 * Untrusted-content boundary + sensitivity fail-close for rendered views
 * (#10/#17; TRD §16, §17.2; PRD §7.5).
 *
 * Everything a view serializes that originated on the page (names, text runs,
 * labels) is DATA, never instructions. Two graph-level controls compose here:
 *
 *  1. Fail-closed sensitivity: upstream redaction (Judgment Engine) must have
 *     already replaced pii/secret/credential text. If a node labeled sensitive
 *     still carries page text when a view renders, the redaction contract was
 *     violated, and the whole view fails closed rather than serializing the leak.
 *  2. Delimited serialization: the rendered payload is wrapped in
 *     `UNTRUSTED_UI_CONTENT` boundary markers, and any occurrence of the
 *     markers *inside* page-derived text is neutralized first, so page content
 *     can neither close the boundary early nor open a fake trusted section.
 *     ASCII control characters (except \n\t) are stripped from page text, so
 *     instruction-smuggling via terminal/control syntax is not representable.
 *
 * Metrics/telemetry never receive raw text: `sensitiveTextDigest` reports a
 * count + hash only.
 */

import { createHash } from "node:crypto";
import { UIGraphError } from "../api.js";
import type { SensitivityLabel } from "../types.js";

export const UNTRUSTED_UI_CONTENT_OPEN = "<<<UNTRUSTED_UI_CONTENT>>>" as const;
export const UNTRUSTED_UI_CONTENT_CLOSE = "<<<END_UNTRUSTED_UI_CONTENT>>>" as const;

/** Labels whose text must not survive into a rendered view. */
const FAIL_CLOSED_LABELS: ReadonlySet<SensitivityLabel> = new Set(["pii", "secret", "credential"]);

/** Neutralize boundary forgery + strip control syntax from one page-derived string. */
export function sanitizeUntrustedText(value: string): string {
  return value
    .replaceAll(UNTRUSTED_UI_CONTENT_OPEN, "[untrusted-marker-removed]")
    .replaceAll(UNTRUSTED_UI_CONTENT_CLOSE, "[untrusted-marker-removed]")
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** Wrap a serialized view payload in the untrusted-content boundary. */
export function delimitUntrusted(serialized: string): string {
  return `${UNTRUSTED_UI_CONTENT_OPEN}\n${serialized}\n${UNTRUSTED_UI_CONTENT_CLOSE}`;
}

/** A page-text field: plain string or a FusedFact-shaped `{ value }` wrapper. */
export type UntrustedTextField = string | { value?: unknown } | undefined;

export interface SensitivityCheckedNode {
  candidateId?: string;
  nodeId?: string;
  sensitivity?: readonly SensitivityLabel[];
  name?: UntrustedTextField;
  text?: UntrustedTextField;
}

function textOf(field: UntrustedTextField): string | null {
  if (typeof field === "string") return field;
  if (field !== null && typeof field === "object" && typeof field.value === "string") return field.value;
  return null;
}

function withText<F extends UntrustedTextField>(field: F, next: string): F {
  if (typeof field === "string") return next as F;
  return { ...(field as object), value: next } as F;
}

/** Count + digest only; raw sensitive text never reaches logs or metrics. */
export function sensitiveTextDigest(values: readonly string[]): { count: number; digest: string } {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value, "utf8");
  return { count: values.length, digest: `sha256:${hash.digest("hex").slice(0, 16)}` };
}

/**
 * Fail closed if any sensitive-labeled node still carries page text after the
 * upstream redaction stage (TRD §17.2). A `redacted` label with empty text is
 * the healthy outcome; surviving text on pii/secret/credential is a contract
 * violation and the view must not render.
 */
export function assertNoSensitiveTextSurvives(nodes: readonly SensitivityCheckedNode[]): void {
  const surviving: string[] = [];
  const ids: string[] = [];
  for (const node of nodes) {
    if (!node.sensitivity?.some((label) => FAIL_CLOSED_LABELS.has(label))) continue;
    for (const field of [node.name, node.text]) {
      const value = textOf(field);
      if (value !== null && value.trim().length > 0) {
        surviving.push(value);
        ids.push(node.candidateId ?? node.nodeId ?? "unknown");
      }
    }
  }
  if (surviving.length > 0) {
    const { count, digest } = sensitiveTextDigest(surviving);
    throw new UIGraphError(
      "invalid_view_spec",
      `sensitive text survived redaction on ${count} field(s) (nodes: ${[...new Set(ids)].join(", ")}; ${digest}); refusing to render the view`,
    );
  }
}

/** Sanitize the page-derived text fields of a node copy (never mutates input). */
export function sanitizeNodeText<T extends SensitivityCheckedNode>(node: T): T {
  const copy = { ...node };
  const name = textOf(copy.name);
  if (name !== null) copy.name = withText(copy.name, sanitizeUntrustedText(name));
  const text = textOf(copy.text);
  if (text !== null) copy.text = withText(copy.text, sanitizeUntrustedText(text));
  return copy;
}
