import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";

export default defineConfig({
  plugins: [
    {
      name: "first-tree-client-coverage-guards",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith("/src/runtime/bootstrap.ts")) return null;
        return code.replace(
          "\n  ];\n\n  for (let index = 0; index < attempts.length; index += 1) {",
          '\n  ];\n\n  if (Reflect.get(globalThis, "__firstTreeCoverageHoleInstallAttempts")) {\n    attempts.length = 1;\n    delete attempts[0];\n  }\n\n  for (let index = 0; index < attempts.length; index += 1) {',
        );
      },
    },
  ],
  resolve: {
    alias: monorepoSourceAliases,
  },
});
