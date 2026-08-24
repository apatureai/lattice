import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  validateSnapshot,
  validateView,
  validateDelta,
  formatErrors,
} from "@apatureai/lattice";

const load = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./examples/${name}`, import.meta.url)), "utf8"),
  );

const minimalSnapshot = load("minimal-snapshot.json");
const minimalView = load("minimal-view.json");
const minimalDelta = load("minimal-delta.json");

describe("schema validators accept golden fixtures", () => {
  it("accepts the minimal snapshot", () => {
    const r = validateSnapshot(minimalSnapshot);
    expect(r.valid, r.valid ? "" : formatErrors(r.errors)).toBe(true);
  });

  it("accepts the minimal view", () => {
    const r = validateView(minimalView);
    expect(r.valid, r.valid ? "" : formatErrors(r.errors)).toBe(true);
  });

  it("accepts the minimal delta", () => {
    const r = validateDelta(minimalDelta);
    expect(r.valid, r.valid ? "" : formatErrors(r.errors)).toBe(true);
  });
});

describe("strict validators reject unknown top-level fields", () => {
  it("rejects an extra snapshot field", () => {
    const bad = { ...(minimalSnapshot as object), notAField: true };
    const r = validateSnapshot(bad);
    expect(r.valid).toBe(false);
  });

  it("rejects an extra view field", () => {
    const bad = { ...(minimalView as object), notAField: true };
    const r = validateView(bad);
    expect(r.valid).toBe(false);
  });

  it("rejects an extra delta field", () => {
    const bad = { ...(minimalDelta as object), notAField: true };
    const r = validateDelta(bad);
    expect(r.valid).toBe(false);
  });
});

describe("strict validators reject malformed instances", () => {
  it("rejects a snapshot missing required fields", () => {
    const r = validateSnapshot({ schemaVersion: "1.0.0" });
    expect(r.valid).toBe(false);
  });

  it("rejects a snapshot with a non-approved DNA projection claiming authoritative matches", () => {
    const snap = structuredClone(minimalSnapshot) as Record<string, unknown>;
    snap.dnaProjection = {
      dnaVersion: "dna@1",
      projectionSchemaVersion: "1.0.0",
      dnaContentDigest:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      state: "draft",
      useMode: "shadow",
      authoritativeMatchCount: 3, // forbidden: non-approved DNA must force 0
      advisoryMatchCount: 0,
      driftCount: 0,
    };
    const r = validateSnapshot(snap);
    expect(r.valid).toBe(false);
  });
});
