import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";
import { MAX_FORKS } from "./src/__tests__/test-config.js";

export default defineConfig({
  test: {
    globalSetup: "./src/__tests__/global-setup.ts",
    setupFiles: ["./src/__tests__/setup.ts"],
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: {
      forks: {
        // Re-use the worker process across files so we don't pay fastify +
        // module-graph load on every file. Combined with the low maxForks
        // cap from test-config.ts, leaked module state stays bounded.
        isolate: false,
        maxForks: MAX_FORKS,
        minForks: 1,
      },
    },
  },
  resolve: {
    alias: monorepoSourceAliases,
  },
});
