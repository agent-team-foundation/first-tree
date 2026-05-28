import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";
import { unitCoverageConfig } from "../../scripts/vitest-coverage.js";

export default defineConfig({
  test: {
    coverage: unitCoverageConfig(),
  },
  resolve: {
    alias: monorepoSourceAliases,
  },
  test: {
    // Install a default CLI binding before every test file so handler-level
    // tests that indirectly invoke `bootstrap.ts` don't have to stub it
    // themselves. See vitest.setup.ts for details.
    setupFiles: ["./vitest.setup.ts"],
  },
});
