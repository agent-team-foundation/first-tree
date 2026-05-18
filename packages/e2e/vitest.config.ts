import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/tests/**/*.e2e.test.ts"],
    globalSetup: ["./src/framework/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 90_000,
    teardownTimeout: 30_000,
    reporters: ["default"],
  },
});
