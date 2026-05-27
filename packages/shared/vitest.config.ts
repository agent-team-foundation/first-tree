import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: [...coverageConfigDefaults.exclude, "src/config/types.ts"],
    },
  },
});
