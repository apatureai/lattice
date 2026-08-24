/**
 * The live browser suite, kept out of `pnpm test` on purpose.
 *
 * `pnpm test` must run from a clean clone with nothing but Node and pnpm, so the
 * tests that need a Chromium binary live under `test-browser/` and run through
 * this config with `pnpm test:browser`. Nothing here is skipped conditionally: a
 * run either has the browser and asserts everything, or it is not this suite.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@apatureai/lattice": fromRoot("./packages/schema/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test-browser/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Browser launches are the cost here; running the files in one process keeps
    // the suite honest about that instead of hiding it behind parallelism.
    fileParallelism: false,
  },
});
