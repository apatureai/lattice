import { describe, expect, it } from "vitest";

import {
  checkRect,
  compose,
  IDENTITY,
  normalizeColor,
  normalizeCssLength,
  normalizeMatchText,
  transformRect,
  withinTolerance,
} from "@apature/ui-graph";

describe("normalizeColor", () => {
  it("expands 3-digit hex to #rrggbb", () => {
    expect(normalizeColor("#FfF").canonical).toBe("#ffffff");
  });
  it("keeps 6-digit hex and drops opaque alpha", () => {
    expect(normalizeColor("#0a0b0cff").canonical).toBe("#0a0b0c");
    expect(normalizeColor("#0a0b0c80").canonical).toBe("#0a0b0c80");
  });
  it("parses rgb/rgba", () => {
    expect(normalizeColor("rgb(255, 0, 0)").canonical).toBe("#ff0000");
    expect(normalizeColor("rgba(0,0,0,0.5)").canonical).toBe("#00000080");
  });
  it("resolves a named subset", () => {
    expect(normalizeColor("white").canonical).toBe("#ffffff");
    expect(normalizeColor("transparent").canonical).toBe("#00000000");
  });
  it("returns null for unparseable input but keeps the original", () => {
    const r = normalizeColor("not-a-color");
    expect(r.canonical).toBeNull();
    expect(r.original).toBe("not-a-color");
  });
});

describe("normalizeCssLength", () => {
  it("passes through px and absolute units", () => {
    expect(normalizeCssLength("16px").valueCssPx).toBe(16);
    expect(normalizeCssLength("1in").valueCssPx).toBe(96);
    expect(normalizeCssLength(24).valueCssPx).toBe(24);
  });
  it("keeps the unit but no px value for relative units", () => {
    const rem = normalizeCssLength("1.5rem");
    expect(rem.unit).toBe("rem");
    expect(rem.valueCssPx).toBeNull();
  });
  it("returns nulls for non-numeric input", () => {
    expect(normalizeCssLength("auto").valueCssPx).toBeNull();
    expect(normalizeCssLength("auto").unit).toBeNull();
  });
});

describe("normalizeMatchText", () => {
  it("NFC-normalizes, collapses whitespace, trims and case-folds", () => {
    expect(normalizeMatchText("  Foo\tBar\nBaz  ").matchKey).toBe("foo bar baz");
  });
  it("empties the key for redacted runs but keeps display", () => {
    const r = normalizeMatchText("secret", true);
    expect(r.matchKey).toBe("");
    expect(r.display).toBe("secret");
  });
});

describe("geometry", () => {
  it("compose(IDENTITY, t) === t for translation", () => {
    expect(compose(IDENTITY, [1, 0, 0, 1, 5, 7])).toEqual([1, 0, 0, 1, 5, 7]);
  });
  it("transforms a rect by translation", () => {
    expect(transformRect([1, 0, 0, 1, 10, 20], { x: 0, y: 0, width: 4, height: 6 })).toEqual({
      x: 10,
      y: 20,
      width: 4,
      height: 6,
    });
  });
  it("transforms a rect by scale", () => {
    expect(transformRect([2, 0, 0, 3, 0, 0], { x: 1, y: 1, width: 4, height: 2 })).toEqual({
      x: 2,
      y: 3,
      width: 8,
      height: 6,
    });
  });
  it("tolerance allows 2px or 0.5%", () => {
    expect(withinTolerance(100, 101)).toBe(true);
    expect(withinTolerance(100, 103)).toBe(false);
    expect(withinTolerance(10000, 10040)).toBe(true); // 0.5% of 10000 = 50
  });
  it("checkRect flags non-finite and overflow", () => {
    expect(checkRect({ x: 0, y: 0, width: 1, height: 1 }).ok).toBe(true);
    expect(checkRect({ x: Number.NaN, y: 0, width: 1, height: 1 })).toEqual({ ok: false, reason: "non_finite" });
    expect(checkRect({ x: 1e9, y: 0, width: 1, height: 1 })).toEqual({ ok: false, reason: "overflow" });
  });
});
