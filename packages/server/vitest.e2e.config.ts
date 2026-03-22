import { defineConfig } from "vitest/config";

/** E2E tests — uses local docker-compose PG, no testcontainers. */
export default defineConfig({
  test: {
    include: ["src/__tests__/e2e-*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
