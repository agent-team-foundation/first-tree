import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";
import { unitCoverageConfig } from "../../scripts/vitest-coverage.js";
import { resolveVitestMaxForks } from "../../scripts/vitest-max-forks.js";

const maxForks = resolveVitestMaxForks(2);

// Many web tests import `.tsx` modules, and the DOM smoke tests render React
// directly, so the React plugin is needed at transform time to strip JSX.
export default defineConfig({
  plugins: [react()],
  // `__WEB_BUILD_ID__` is injected by Vite's `define` at build time (see
  // vite.config.ts). Vitest doesn't read that config, so provide a stub here so
  // components that read it (e.g. NewVersionChip) don't hit a ReferenceError
  // when rendered in tests.
  define: {
    __WEB_BUILD_ID__: JSON.stringify("test"),
  },
  test: {
    coverage: unitCoverageConfig(),
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Cap forks so jsdom/react suites do not stack on the same ~7GB GH runner
    // as server/cli tests under turbo.
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks,
        minForks: 1,
      },
    },
  },
  resolve: {
    alias: monorepoSourceAliases,
  },
});
