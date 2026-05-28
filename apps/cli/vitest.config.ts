import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";
import { unitCoverageConfig } from "../../scripts/vitest-coverage.js";

export default defineConfig({
  test: {
    coverage: unitCoverageConfig({
      exclude: ["src/commands/types.ts"],
    }),
  },
  resolve: {
    alias: monorepoSourceAliases,
  },
});
