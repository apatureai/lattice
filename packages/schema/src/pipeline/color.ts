/**
 * Deterministic CSS color normalization (TRD §8.2).
 *
 * Colors are canonicalized to lowercase `#rrggbb` (or `#rrggbbaa` when alpha is
 * not fully opaque) for stable matching, while the original token is preserved
 * by the caller. Unparseable colors return `null` so the caller can keep the
 * original as evidence and emit a warning rather than fabricate a value.
 */

export interface NormalizedColor {
  readonly original: string;
  /** Canonical `#rrggbb`/`#rrggbbaa`, or null when the input is unparseable. */
  readonly canonical: string | null;
}

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i;
const HEX6 = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;
const RGB = /^rgba?\(\s*([^)]*)\)$/i;

/** Minimal named-color subset commonly emitted as style facts. */
const NAMED: Record<string, string> = {
  transparent: "#00000000",
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
};

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return NaN;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function withAlpha(rgb: string, alpha: number): string {
  // alpha in [0,1]; omit the alpha pair when fully opaque.
  if (!(alpha >= 0 && alpha <= 1)) return rgb; // out-of-range alpha → treat opaque
  if (alpha >= 1) return rgb;
  return rgb + hex2(clampByte(alpha * 255));
}

export function normalizeColor(input: string): NormalizedColor {
  const original = input;
  const value = input.trim().toLowerCase();

  // `Object.hasOwn`, not `in`: the input is untrusted capture data, and `in`
  // walks the prototype chain, so a color fact of `constructor`/`__proto__` would
  // otherwise resolve to an inherited value and leak a non-string `canonical`.
  if (Object.hasOwn(NAMED, value)) {
    return { original, canonical: NAMED[value] ?? null };
  }

  const hex3 = HEX3.exec(value);
  if (hex3) {
    const [, r, g, b, a] = hex3;
    const base = `#${r}${r}${g}${g}${b}${b}`;
    const canonical = a !== undefined ? base + `${a}${a}` : base;
    return { original, canonical };
  }

  const hex6 = HEX6.exec(value);
  if (hex6) {
    const [, rgb, aa] = hex6;
    const canonical = aa !== undefined && aa.toLowerCase() !== "ff" ? `#${rgb}${aa}` : `#${rgb}`;
    return { original, canonical };
  }

  const rgb = RGB.exec(value);
  if (rgb) {
    const parts = (rgb[1] ?? "").split(/[,/\s]+/).filter((p) => p.length > 0);
    if (parts.length === 3 || parts.length === 4) {
      const r = clampByte(Number(parts[0]));
      const g = clampByte(Number(parts[1]));
      const b = clampByte(Number(parts[2]));
      if ([r, g, b].every(Number.isFinite)) {
        const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
        const alpha = parts.length === 4 ? Number(parts[3]) : 1;
        return { original, canonical: Number.isFinite(alpha) ? withAlpha(base, alpha) : base };
      }
    }
  }

  return { original, canonical: null };
}
