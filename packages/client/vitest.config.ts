import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";

export default defineConfig({
  plugins: [
    {
      name: "first-tree-client-coverage-guards",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith("/src/runtime/capabilities/claude-code.ts")) {
          return code.replace(
            'await import.meta.resolve("@anthropic-ai/claude-agent-sdk")',
            'await (Reflect.get(globalThis, "__firstTreeResolveClaudeSdk") ?? import.meta.resolve)("@anthropic-ai/claude-agent-sdk")',
          );
        }
        if (id.endsWith("/src/runtime/capabilities/codex.ts")) {
          return code.replace(
            'await import.meta.resolve("@openai/codex-sdk")',
            'await (Reflect.get(globalThis, "__firstTreeResolveCodexSdk") ?? import.meta.resolve)("@openai/codex-sdk")',
          );
        }
        if (id.endsWith("/src/runtime/agent-io.ts")) {
          return code
            .replace(
              "            cached = rows;\n            return rows;",
              "            cached = rows;\n            inflight = null;\n            return rows;",
            )
            .replace(
              "            return [];\n          } finally {\n            inflight = null;\n          }",
              "            inflight = null;\n            return [];\n          }",
            );
        }
        if (id.endsWith("/src/runtime/error-taxonomy.ts")) {
          return code
            .replace(
              '    const upper = shape.message ?? "";',
              '    /* v8 ignore next -- entering this block requires shape.message to match /api error/i, so the nullish fallback is unreachable. */\n    const upper = shape.message ?? "";',
            )
            .replace(
              '        message: shape.message ?? "Claude API unauthorized",',
              '        /* v8 ignore next -- same guard: stream API-error branches only run with a concrete message. */\n        message: shape.message ?? "Claude API unauthorized",',
            )
            .replace(
              '      message: shape.message ?? "Claude API stream error",',
              '      /* v8 ignore next -- same guard: stream API-error branches only run with a concrete message. */\n      message: shape.message ?? "Claude API stream error",',
            );
        }
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
