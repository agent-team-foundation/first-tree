import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    coverage: {
      include: [
        "src/github-scan/engine/runtime/classifier.ts",
        "src/github-scan/engine/runtime/paths.ts",
        "src/github-scan/engine/runtime/task-kind.ts",
        "src/github-scan/engine/runtime/types.ts",
      ],
    },
    // Daemon tests spawn child processes, bind HTTP servers, and
    // wait on advisory locks. Cold-start runs can occasionally brush
    // the default 5s ceiling on slower machines (notably the runDaemon
    // pre-aborted-signal end-to-end). Give them headroom.
    testTimeout: 20_000,
  },
});
