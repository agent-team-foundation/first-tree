import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const sharedExclude = [
  "**/node_modules/**",
  "dist/**",
  "**/cypress/**",
  "**/.{idea,git,cache,output,temp}/**",
  "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
];

const heavyGlobs = [
  "tests/e2e/**/*.test.ts",
  "tests/tree/**/*.test.ts",
];

export default defineConfig({
  plugins: [
    {
      name: "raw-md",
      transform(_code: string, id: string) {
        if (id.endsWith(".md")) {
          const content = readFileSync(id, "utf-8");
          return { code: `export default ${JSON.stringify(content)};` };
        }
      },
    },
  ],
  test: {
    // Heavy tests under tests/e2e and tests/tree spawn real `pnpm pack`/`pnpm build`
    // and run the built CLI. Under default parallelism they fight for CPU and
    // flake on 15s per-test timeouts. Split into two projects so the heavy set
    // runs with fileParallelism disabled while unit tests stay fast.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "tests/**/*.test.ts",
            "tests/**/*.test.tsx",
            "evals/tests/**/*.test.ts",
          ],
          exclude: [...sharedExclude, ...heavyGlobs],
        },
      },
      {
        extends: true,
        test: {
          name: "heavy",
          include: heavyGlobs,
          exclude: sharedExclude,
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
