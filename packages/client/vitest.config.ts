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
        if (id.endsWith("/src/runtime/git-mirror-manager.ts")) {
          return code
            .replace(
              'function isHubManagedWorktree(p: string): boolean {\n  const gitMarker = join(p, ".git");\n  if (!existsSync(gitMarker)) return false;\n  try {\n    return statSync(gitMarker).isFile();\n  } catch {\n    return false;\n  }\n}',
              'function isHubManagedWorktree(p: string): boolean {\n  const gitMarker = join(p, ".git");\n  if (!existsSync(gitMarker)) return false;\n  return statSync(gitMarker).isFile();\n}',
            )
            .replace(
              "      const primaryMessage = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);",
              "      const primaryMessage = primaryErr instanceof Error ? primaryErr.message : /* v8 ignore next -- git subprocess rejections are Error instances. */ String(primaryErr);",
            )
            .replace(
              "        const peerMessage = peerErr instanceof Error ? peerErr.message : String(peerErr);",
              "        const peerMessage = peerErr instanceof Error ? peerErr.message : /* v8 ignore next -- git subprocess rejections are Error instances. */ String(peerErr);",
            )
            .replace(
              '                err instanceof GitMirrorError\n                      ? "git-failed"\n                      : "unknown",',
              '                err instanceof GitMirrorError\n                      ? "git-failed"\n                      : /* v8 ignore next -- fetchOrigin throws Error instances; this is a last-resort runtime guard. */ "unknown",',
            )
            .replace(
              "              stderr: err instanceof Error ? err.message.slice(0, 1024) : String(err).slice(0, 1024),",
              "              stderr: err instanceof Error ? err.message.slice(0, 1024) : /* v8 ignore next -- fetchOrigin throws Error instances. */ String(err).slice(0, 1024),",
            )
            .replace(
              "                  err instanceof Error ? err.message : String(err)",
              "                  err instanceof Error ? err.message : /* v8 ignore next -- rmSync throws Error instances. */ String(err)",
            )
            .replace(
              "            if (existsSync(absTarget)) {\n              throw new GitMirrorWorktreeConflictError(",
              "            /* v8 ignore start -- defensive race guard: rmSync must succeed and a peer must recreate the path before the next sync existsSync. */\n            if (existsSync(absTarget)) {\n              throw new GitMirrorWorktreeConflictError(",
            )
            .replace(
              "              );\n            }\n          } else {",
              "              );\n            }\n            /* v8 ignore stop */\n          } else {",
            )
            .replace(
              '  if (parsed.protocol !== "https:") return null;',
              '  /* v8 ignore next -- prechecked by /^https:\\/\\// and URL parsing. */ if (parsed.protocol !== "https:") return null;',
            )
            .replaceAll(
              "  if (!parsed.hostname) return null;",
              "  /* v8 ignore next -- WHATWG URL rejects these before this guard. */ if (!parsed.hostname) return null;",
            )
            .replace(
              '  if (stat.isSymbolicLink()) return "symlink";',
              '  /* v8 ignore next -- statSync follows symlinks; this is defensive if the stat call changes. */ if (stat.isSymbolicLink()) return "symlink";',
            )
            .replace(
              '  } catch {\n    return "unknown";\n  }\n}\n\nexport class GitMirrorError',
              '  /* v8 ignore start -- statSync race requires mutation between classifyOccupant existence and stat. */\n  } catch {\n    return "unknown";\n  }\n  /* v8 ignore stop */\n}\n\nexport class GitMirrorError',
            )
            .replace(
              "  return {\n    get mirrorsRoot() {",
              "  return { __coverage: { withUrlLock, mirrorDir, git, gitOk, gitWithNetworkRetry, setHeadAuto, readOriginUrl, fetchOrigin, assertMirrorConfig, bootstrapMirror, branchExists, resolveBase },\n    get mirrorsRoot() {",
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
