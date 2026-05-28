import { defineConfig } from "vitest/config";
import { unitCoverageConfig } from "../../scripts/vitest-coverage.js";

export default defineConfig({
  test: {
    coverage: unitCoverageConfig({
      exclude: ["src/config/types.ts"],
    }),
  },
});
