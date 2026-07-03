/**
 * @apature/ui-graph — deterministic, UI-DNA-aware visual scene graph contract.
 *
 * Per core #103 DECISION 4, UI Graph is a feature-flagged representation
 * EXPERIMENT until its precision/grounding/cost/latency eval proves value. This
 * package is the contract + deterministic representation library consumed by
 * Judgment Engine; it never calls a model, browser, sandbox, or network.
 */

export * from "./types.js";
export * from "./validate.js";
export * from "./api.js";
export * from "./canonical.js";
export * from "./readprofile.js";
export * from "./adapter.js";
export * from "./pipeline/index.js";
export * from "./eval/index.js";
