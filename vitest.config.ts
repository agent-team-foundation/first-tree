import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

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
    include: [
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "evals/tests/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
    ],
  },
});
