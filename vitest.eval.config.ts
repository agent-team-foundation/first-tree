import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['skills/first-tree-cli-framework/evals/context-tree-eval.test.ts'],
    testTimeout: 720_000,    // 12 min per test (10 min agent + setup/verify overhead)
    hookTimeout: 30_000,
    pool: 'forks',           // Process isolation for subprocess spawning
  },
});
