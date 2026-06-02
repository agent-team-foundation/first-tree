import { defineConfig } from "vitest/config";

/**
 * Vitest config for the `claude-code-tui` scenarios — boots a TUI-mode world
 * (daemon spawned with the fake-tui binary on CLAUDE_CODE_EXECUTABLE + a
 * fake ANTHROPIC_API_KEY) and only runs `src/tests/tui-*.e2e.test.ts`.
 *
 * Kept separate from the default `vitest.config.ts` because the fake-tui
 * binary does NOT speak the SDK stream-json protocol — sharing the world
 * with the existing SDK-based suites would break the SDK tests. Run via
 * `pnpm --filter @first-tree/e2e e2e:tui`.
 */
export default defineConfig({
  test: {
    name: "tui",
    include: ["src/tests/tui-*.e2e.test.ts"],
    globalSetup: ["./src/framework/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
    reporters: ["default"],
    // Force `E2E_TUI=1` for the duration of this run so global-setup picks
    // the fake-tui binary even if the operator forgot to export it.
    env: { E2E_TUI: "1", E2E_WITH_CLIENT: "1" },
  },
});
