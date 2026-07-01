/**
 * Representation evaluation surface (PRD §8, TRD §15).
 *
 * UI Graph owns the frozen fixture manifests + labels; Judgment Engine runs the
 * eval. This barrel exposes the manifest format (issue #19) and the frozen
 * manifest data the benchmark (#20) and promotion gate (#24) consume.
 */

export * from "./manifest.js";
export { REPRESENTATION_MANIFEST } from "./fixtures.js";
