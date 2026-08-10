/**
 * The computed-style properties this adapter asks Chromium for, and how they
 * are named on the way into lattice.
 *
 * `DOMSnapshot.captureSnapshot` takes an explicit property list and returns the
 * resolved values string-interned, one array per layout node in exactly this
 * order. Asking for a bounded, named list (rather than every property) is what
 * keeps a capture of a large page a bounded size, and it makes the mapping to
 * lattice's `styleFacts` keys reviewable in one place.
 *
 * The key names on the right are chosen to match what lattice's style projection
 * looks for (`packages/schema/src/builder.ts`):
 *
 *  - anything matching `/colou?r/i` is normalized as a color;
 *  - `fontSize` / `lineHeight` are read as CSS lengths;
 *  - keys containing `borderRadius` become the node's radius list;
 *  - keys starting `margin` / `padding` / `gap` / `rowGap` / `columnGap` become
 *    the node's spacing map.
 *
 * `visibility` and `z-index` are requested but deliberately NOT emitted as style
 * facts: they feed the node's `visible` flag and its `zIndex` field instead.
 */

/** CSS property name (what CDP is asked for) paired with its `styleFacts` key. */
export const STYLE_PROPERTIES: ReadonlyArray<readonly [css: string, fact: string | null]> = [
  ["color", "color"],
  ["background-color", "backgroundColor"],
  ["font-family", "fontFamily"],
  ["font-size", "fontSize"],
  ["font-weight", "fontWeight"],
  ["line-height", "lineHeight"],
  ["opacity", "opacity"],
  ["display", "display"],
  ["position", "position"],
  ["border-top-left-radius", "borderRadiusTopLeft"],
  ["border-top-right-radius", "borderRadiusTopRight"],
  ["border-bottom-right-radius", "borderRadiusBottomRight"],
  ["border-bottom-left-radius", "borderRadiusBottomLeft"],
  ["margin-top", "marginTop"],
  ["margin-right", "marginRight"],
  ["margin-bottom", "marginBottom"],
  ["margin-left", "marginLeft"],
  ["padding-top", "paddingTop"],
  ["padding-right", "paddingRight"],
  ["padding-bottom", "paddingBottom"],
  ["padding-left", "paddingLeft"],
  ["row-gap", "rowGap"],
  ["column-gap", "columnGap"],
  // Read for the visible flag and the zIndex field, not emitted as facts.
  ["visibility", null],
  ["z-index", null],
];

/** The `computedStyles` argument for `DOMSnapshot.captureSnapshot`. */
export const REQUESTED_COMPUTED_STYLES: readonly string[] = STYLE_PROPERTIES.map(([css]) => css);

/** Position of `visibility` in the returned per-node style array. */
export const VISIBILITY_INDEX = STYLE_PROPERTIES.findIndex(([css]) => css === "visibility");

/** Position of `z-index` in the returned per-node style array. */
export const Z_INDEX_INDEX = STYLE_PROPERTIES.findIndex(([css]) => css === "z-index");
