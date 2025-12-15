import { defineConfig } from "vitest/config";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ["svelte", "browser", "import", "module"],
    alias: {
      "convex-svelte": resolve(__dirname, "node_modules/convex-svelte/dist/index.js"),
    },
  },
  test: {
    environment: "edge-runtime",
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
  },
});
