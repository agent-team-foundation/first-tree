import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['evals/context-tree-eval.test.ts'],
    testTimeout: 600_000,    // 10 min per test (agent runs are slow)
    hookTimeout: 30_000,
    pool: 'forks',           // Process isolation for subprocess spawning
  },
});
