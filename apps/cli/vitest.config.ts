import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";
import { unitCoverageConfig } from "../../scripts/vitest-coverage.js";

export default defineConfig({
  test: {
    // Many CLI tests spawn the command as a subprocess and do real file/process
    // I/O. They run ~1-2s in isolation but are CPU-bound, so under the
    // full-monorepo `turbo run test` (every package in parallel) CI runners get
    // starved and an occasional, varying handful cross vitest's default 5s
    // timeout — flaky red driven by an unrelated PR's added load, not by logic
    // (they pass when this package runs alone). Raise the package-wide timeout
    // so transient CPU starvation can't trip them; a genuine hang still fails,
    // just at 15s.
    testTimeout: 15_000,
    coverage: unitCoverageConfig({
      exclude: ["src/commands/types.ts"],
    }),
  },
  resolve: {
    alias: monorepoSourceAliases,
  },
});
