import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";
import { unitCoverageConfig } from "../../scripts/vitest-coverage.js";
import { resolveVitestMaxForks } from "../../scripts/vitest-max-forks.js";

const maxForks = resolveVitestMaxForks(2);

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
    // Cap forks so client tests do not overcommit memory when turbo runs
    // server/web/cli suites on the same GH runner (~7GB).
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks,
        minForks: 1,
      },
    },
  },
});
