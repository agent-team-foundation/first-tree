import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Daemon tests spawn child processes, bind HTTP servers, and
    // wait on advisory locks. Cold-start runs can occasionally brush
    // the default 5s ceiling on slower machines (notably the runDaemon
    // pre-aborted-signal end-to-end). Give them headroom.
    testTimeout: 20_000,
  },
});
