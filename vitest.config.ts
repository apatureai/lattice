import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@apature/ui-graph": fromRoot("./packages/schema/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
