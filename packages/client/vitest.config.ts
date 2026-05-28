import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";
import { unitCoverageConfig } from "../../scripts/vitest-coverage.js";

export default defineConfig({
  resolve: {
    alias: monorepoSourceAliases,
  },
  test: {
    coverage: unitCoverageConfig(),
    // Install a default CLI binding before every test file so handler-level
    // tests that indirectly invoke `bootstrap.ts` don't have to stub it
    // themselves. See vitest.setup.ts for details.
    setupFiles: ["./vitest.setup.ts"],
  },
});
