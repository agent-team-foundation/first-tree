import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";
import { unitCoverageConfig } from "../../scripts/vitest-coverage.js";
import { isCiEnvironment, resolveVitestMaxForks } from "../../scripts/vitest-max-forks.js";

// Keep a single `vitest run` in package.json. Splitting into multi-process
// shell chains (login → portable → … → bulk) restarts collect/transform each
// time, lengthens CI, and still OOM'd the bulk batch on GH runners. Memory
// pressure is controlled here + in `.github/workflows/ci.yml` instead.
const maxForks = resolveVitestMaxForks(2);
const isCi = isCiEnvironment();

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
    // Known heavy files (large mock graphs / dynamic import of command trees):
    // - src/__tests__/client-runtime-context-tree.test.ts
    // - src/__tests__/service-install-core.test.ts
    // - src/__tests__/login-command.test.ts
    // - src/__tests__/update-portable-install.test.ts
    // Under CI we serialize file execution so those graphs cannot sit in two
    // fork heaps at once next to server/web suites.
    fileParallelism: !isCi && maxForks > 1,
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks,
        minForks: 1,
        // Explicit isolate so each file gets a clean module graph; without it
        // the ~100 CLI files can accumulate transform/module state toward the
        // ~4GB Node heap ceiling (observed as JSON.stringify OOM in tinypool).
        isolate: true,
      },
    },
    coverage: unitCoverageConfig({
      exclude: ["src/commands/types.ts"],
    }),
  },
  resolve: {
    alias: monorepoSourceAliases,
  },
});
