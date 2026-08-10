/**
 * Implicit-role mapping for the DOM side of the capture.
 *
 * lattice fuses a DOM role claim with an accessibility role claim and keeps both
 * when they disagree. That only produces a useful signal if the DOM side
 * actually states a role, so this module derives one from the tag name and the
 * handful of attributes that change it, the way the HTML-AAM mapping does.
 *
 * This is deliberately a SUBSET and the adapter says so. It covers the tags that
 * carry semantics an agent acts on; anything else reports no DOM role and the
 * accessibility tree is left to speak alone. An approximation that is honest
 * about being one is safe here, because lattice never lets one source overwrite
 * another: a wrong guess would surface as a retained conflict with lowered
 * confidence, not as a silently wrong node.
 */

const SIMPLE_ROLES: Readonly<Record<string, string>> = {
  article: "article",
  aside: "complementary",
  button: "button",
  datalist: "listbox",
  dd: "definition",
  details: "group",
  dialog: "dialog",
  dt: "term",
  fieldset: "group",
  figure: "figure",
  form: "form",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  hr: "separator",
  html: "document",
  img: "img",
  li: "listitem",
  main: "main",
  math: "math",
  menu: "list",
  meter: "meter",
  nav: "navigation",
  ol: "list",
  optgroup: "group",
  option: "option",
  output: "status",
  p: "paragraph",
  progress: "progressbar",
  search: "search",
  summary: "button",
  table: "table",
  tbody: "rowgroup",
  textarea: "textbox",
  tfoot: "rowgroup",
  thead: "rowgroup",
  tr: "row",
  ul: "list",
};

/** `<input type=...>` to implicit role. Types not listed have no stable mapping. */
const INPUT_ROLES: Readonly<Record<string, string>> = {
  button: "button",
  checkbox: "checkbox",
  email: "textbox",
  image: "button",
  number: "spinbutton",
  radio: "radio",
  range: "slider",
  reset: "button",
  search: "searchbox",
  submit: "button",
  tel: "textbox",
  text: "textbox",
  url: "textbox",
};

/**
 * The implicit ARIA role of an element, or `undefined` when this adapter has no
 * confident mapping. An explicit `role` attribute always wins and is handled by
 * the caller, not here.
 */
export function implicitRole(
  tag: string,
  attributes: Readonly<Record<string, string>>,
): string | undefined {
  const name = tag.toLowerCase();

  if (name === "a" || name === "area") {
    return attributes["href"] === undefined ? undefined : "link";
  }
  if (name === "input") {
    const type = (attributes["type"] ?? "text").toLowerCase();
    if (type === "search" && attributes["list"] !== undefined) return "combobox";
    if (type === "text" && attributes["list"] !== undefined) return "combobox";
    return INPUT_ROLES[type];
  }
  if (name === "select") {
    const multiple = attributes["multiple"] !== undefined;
    const size = Number(attributes["size"] ?? "1");
    return multiple || size > 1 ? "listbox" : "combobox";
  }
  if (name === "td" || name === "th") {
    // Cell roles depend on the ancestor table's role, which this flat pass does
    // not resolve. `cell` is right for a plain table and the accessibility tree
    // corrects a grid.
    return name === "th" ? "columnheader" : "cell";
  }
  if (name === "section") {
    // Only a named section is a `region`; an unnamed one has no role.
    return attributes["aria-label"] !== undefined || attributes["aria-labelledby"] !== undefined
      ? "region"
      : undefined;
  }
  if (name === "header" || name === "footer") {
    // Scoped to a sectioning element these have no role; at document level they
    // are banner/contentinfo. The flat pass cannot tell, so it stays silent and
    // lets the accessibility tree decide.
    return undefined;
  }
  return SIMPLE_ROLES[name];
}
