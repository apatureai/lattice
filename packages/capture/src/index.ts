/**
 * @apatureai/lattice-capture: the producer lattice was missing.
 *
 * lattice consumes a `CaptureBundleReadProfile` and deliberately owns no
 * browser. This package is the other half: it drives a real Chromium over the
 * DevTools Protocol and emits exactly that read profile, so a scene graph can be
 * built from a URL instead of from a fixture.
 *
 * The capability boundary is why this is a separate package rather than a module
 * inside `@apatureai/lattice`. The core library still ships no browser, no
 * network and no model dependency, and `scripts/capability-guard.mjs` fails CI
 * if that ever stops being true. Nothing here is imported by the core.
 *
 * Three layers, each usable on its own:
 *
 *  - `captureUrl(url, options)` opens a page and returns a capture bundle.
 *  - `captureFromPage(page, options)` captures from a Playwright `Page` the
 *    caller already owns (an authenticated session, a page mid-flow).
 *  - `captureBundleFromCdp(input)` is the pure transform from the two CDP
 *    payloads to the read profile: no browser, no clock, no randomness.
 */

export { captureUrl, captureFromPage, screenshotArtifactRef } from "./browser.js";
export type { CaptureUrlOptions, CapturablePage, CaptureCdpProvider } from "./browser.js";

export { captureFromCdpSession, captureIdFor, routeOf, CAPTURE_VERSION } from "./capture.js";
export type { CdpCaptureOptions } from "./capture.js";

export { captureBundleFromCdp, locationIndependentUrl, CAPTURE_SCHEMA_VERSION } from "./transform.js";
export type {
  CapturePageFacts,
  CaptureTransformInput,
  CaptureTransformOptions,
} from "./transform.js";

export { implicitRole } from "./roles.js";
export { REQUESTED_COMPUTED_STYLES, STYLE_PROPERTIES } from "./style.js";

export type {
  CdpAxNode,
  CdpAxTree,
  CdpDocumentSnapshot,
  CdpDomSnapshot,
  CdpSessionLike,
} from "./cdp-types.js";
