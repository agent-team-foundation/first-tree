import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";
import { unitCoverageConfig } from "../../scripts/vitest-coverage.js";

// Many web tests import `.tsx` modules, and the DOM smoke tests render React
// directly, so the React plugin is needed at transform time to strip JSX.
export default defineConfig({
  plugins: [react()],
  test: {
    coverage: unitCoverageConfig(),
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: monorepoSourceAliases,
  },
});
