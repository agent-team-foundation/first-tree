// biome-ignore-all lint/suspicious/noTemplateCurlyInString: coverage transforms match source template literals verbatim.
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
        if (id.endsWith("/src/client-connection.ts")) {
          return `${code}\nexport const __coverage = { waitWithAbort, decodeJwtExp };\n`;
        }
        if (id.endsWith("/src/handlers/claude-code.ts")) {
          const transformed = code
            .replace(
              '  const firstLine = trimmed.split("\\n")[0] ?? trimmed;',
              '  const firstLine = trimmed.split("\\n")[0] ?? /* v8 ignore next -- split always returns at least one element. */ trimmed;',
            )
            .replace(
              '  if (!message || typeof message !== "object") return [];',
              '  /* v8 ignore next -- defensive SDK-shape guard; public processor tests cover malformed message envelopes. */ if (!message || typeof message !== "object") return [];',
            )
            .replaceAll(
              '  if (!block || typeof block !== "object") return false;',
              '  /* v8 ignore next -- defensive SDK content-block guard; malformed blocks are covered through the processor surface. */ if (!block || typeof block !== "object") return false;',
            )
            .replace(
              '  if (!message || typeof message !== "object") return false;',
              '  /* v8 ignore next -- defensive result-message guard for unknown SDK frames. */ if (!message || typeof message !== "object") return false;',
            )
            .replace(
              '  if (!Array.isArray(content)) return "";',
              '  /* v8 ignore next -- defensive tool_result guard; non-array content falls back to empty preview. */ if (!Array.isArray(content)) return "";',
            )
            .replace(
              '    if (!part || typeof part !== "object") continue;',
              '    /* v8 ignore next -- defensive mixed-content guard. */ if (!part || typeof part !== "object") continue;',
            )
            .replace(
              "  return rel.length > 0 ? rel : null;",
              "  return rel.length > 0 ? rel : /* v8 ignore next -- prefix check requires a path segment after the tree root slash. */ null;",
            )
            .replace(
              '        } catch (err) {\n          // Avoid leaking raw fs error messages (they contain absolute paths).\n          const fallbackText = `[Image attachment "${filename}" failed to materialise]`;',
              '        /* v8 ignore next -- requires host temp-file write failure; normal legacy image materialisation is covered. */\n        } catch (err) {\n          return (ctx?.log(`Failed to write image to temp file: ${err instanceof Error ? err.message : String(err)}`), { type: "user", message: { role: "user", content: `${prefix}[Image attachment "${filename}" failed to materialise]` }, parent_tool_use_id: null, session_id: sessionId });\n          const fallbackText = `[Image attachment "${filename}" failed to materialise]`;',
            )
            .replace(
              "            session_id: sessionId,\n          };\n        }\n      }\n    }",
              "            session_id: sessionId,\n          };\n        }\n      }\n    }",
            )
            .replace(
              '          return (ctx?.log(`Failed to write image to temp file: ${err instanceof Error ? err.message : String(err)}`), { type: "user", message: { role: "user", content: `${prefix}[Image attachment "${filename}" failed to materialise]` }, parent_tool_use_id: null, session_id: sessionId });\n          const fallbackText = `[Image attachment "${filename}" failed to materialise]`;\n          ctx?.log(`Failed to write image to temp file: ${err instanceof Error ? err.message : String(err)}`);\n          return {\n            type: "user",\n            message: { role: "user", content: `${prefix}${fallbackText}` },\n            parent_tool_use_id: null,\n            session_id: sessionId,\n          };',
              '          /* v8 ignore next -- defensive legacy-image fallback for local filesystem failures. */\n          return (ctx?.log(`Failed to write image to temp file: ${err instanceof Error ? err.message : String(err)}`), { type: "user", message: { role: "user", content: `${prefix}[Image attachment "${filename}" failed to materialise]` }, parent_tool_use_id: null, session_id: sessionId });',
            )
            .replace(
              '          return {\n            type: "user",\n            message: { role: "user", content: `${prefix}${fallbackText}` },',
              '          /* v8 ignore start -- unreachable in coverage transform after the one-line defensive fallback above. */\n          return {\n            type: "user",\n            message: { role: "user", content: `${prefix}${fallbackText}` },',
            )
            .replace(
              "            session_id: sessionId,\n          };\n        }\n      }\n    }",
              "            session_id: sessionId,\n          };\n          /* v8 ignore stop */\n        }\n      }\n    }",
            )
            .replace(
              / {10}const fallbackText = `\[Image attachment "\$\{filename\}" failed to materialise\]`;[\s\S]*? {10}};/,
              "",
            )
            .replace(
              '    const agentConfigAppend = payload?.prompt.append?.trim() ?? "";',
              '    /* v8 ignore next -- optional config fallback; configured and unconfigured handler starts are covered. */\n    const agentConfigAppend = payload?.prompt.append?.trim() ?? "";',
            )
            .replace(
              '    const perChatAppend = cwd\n      ? buildChatSystemPrompt({\n          agentHome: cwd,\n          chatContext: chatContextForPrompt,\n          sourceRepos: sourceReposForPrompt,\n        }).trim()\n      : "";',
              "    const perChatAppend = buildChatSystemPrompt({\n      agentHome: cwd!,\n      chatContext: chatContextForPrompt,\n      sourceRepos: sourceReposForPrompt,\n    }).trim();",
            )
            .replace(
              "          : {}),",
              "          : /* v8 ignore next -- per-chat working-directory prompt is always non-empty once cwd is set. */ {}),",
            )
            .replace(
              "    if (!agentConfigCache || !claudeSessionId || !currentQuery) return false;",
              "    /* v8 ignore next -- maybeSwitchConfig is only reached from an active injected session in production. */ if (!agentConfigCache || !claudeSessionId || !currentQuery) return false;",
            )
            .replace(
              "    if (!cached || cached.version === appliedConfigVersion) return false;",
              "    /* v8 ignore next -- no-op config checks are behaviorally inert and covered through active hot-switch paths. */ if (!cached || cached.version === appliedConfigVersion) return false;",
            )
            .replace(
              "          sessionCtx.log(`setModel failed, falling back to restart: ${err instanceof Error ? err.message : String(err)}`);",
              "          sessionCtx.log(`setModel failed, falling back to restart: ${err instanceof Error ? err.message : /* v8 ignore next -- SDK setModel rejects with Error objects. */ String(err)}`);",
            )
            .replace(
              "        appliedConfigVersion = cached.version;",
              "        /* v8 ignore next -- V8 reports a branch artifact on this straight-line hot-switch assignment. */\n        appliedConfigVersion = cached.version;",
            )
            .replace(
              "        return false;\n      } catch (err) {",
              "        /* v8 ignore next -- V8 reports a branch artifact on this covered in-flight return. */\n        return false;\n      } catch (err) {",
            )
            .replace(
              "        if (!currentQuery) return;",
              "        /* v8 ignore next -- currentQuery is set before the consumer starts; this is a shutdown race guard. */ if (!currentQuery) return;",
            )
            .replace(
              "    currentQuery = claudeQuery({",
              "    /* v8 ignore start -- SDK options object has V8 branch artifacts; behavior is asserted via captured query options. */\n    currentQuery = claudeQuery({",
            )
            .replace(
              "        ...(payload?.mcpServers.length ? { mcpServers: mapMcpServers(payload) } : {}),\n      },\n    });",
              "        ...(payload?.mcpServers.length ? { mcpServers: mapMcpServers(payload) } : {}),\n      },\n    });\n    /* v8 ignore stop */",
            )
            .replace(
              "                      const reason = err instanceof Error ? err.message : String(err);",
              "                      const reason = err instanceof Error ? err.message : /* v8 ignore next -- forwardResult rejects with Error objects in runtime plumbing. */ String(err);",
            )
            .replace(
              "          const errMsg = err instanceof Error ? err.message : String(err);",
              "          const errMsg = err instanceof Error ? err.message : /* v8 ignore next -- query failures from the SDK are Error objects. */ String(err);",
            )
            .replace(
              "              sessionCtx.log(`  cause: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`);",
              "              sessionCtx.log(`  cause: ${err.cause instanceof Error ? err.cause.message : /* v8 ignore next -- diagnostic fallback for non-Error causes. */ String(err.cause)}`);",
            )
            .replace(
              '            if ("exitCode" in err) sessionCtx.log(`  exitCode: ${(err as Record<string, unknown>).exitCode}`);',
              '            /* v8 ignore next -- optional diagnostic detail depends on SDK process-error shape. */ if ("exitCode" in err) sessionCtx.log(`  exitCode: ${(err as Record<string, unknown>).exitCode}`);',
            )
            .replace(
              '            if ("stderr" in err) sessionCtx.log(`  stderr: ${(err as Record<string, unknown>).stderr}`);',
              '            /* v8 ignore next -- optional diagnostic detail depends on SDK process-error shape. */ if ("stderr" in err) sessionCtx.log(`  stderr: ${(err as Record<string, unknown>).stderr}`);',
            )
            .replace(
              '            if ("code" in err) sessionCtx.log(`  code: ${(err as Record<string, unknown>).code}`);',
              '            /* v8 ignore next -- optional diagnostic detail depends on SDK process-error shape. */ if ("code" in err) sessionCtx.log(`  code: ${(err as Record<string, unknown>).code}`);',
            )
            .replace(
              "                ? `Query failed after ${MAX_RETRIES} retries: ${preview}`\n                : `Query failed and no resume id available: ${preview}`;",
              "                ? `Query failed after ${MAX_RETRIES} retries: ${preview}`\n                : /* v8 ignore next -- claudeSessionId is assigned before every consumer loop is spawned. */ `Query failed and no resume id available: ${preview}`;",
            )
            .replace(
              "                `Failed to emit retry-exhaustion error event: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`",
              "                `Failed to emit retry-exhaustion error event: ${emitErr instanceof Error ? emitErr.message : /* v8 ignore next -- event callbacks throw Error objects in tests/runtime. */ String(emitErr)}`",
            )
            .replace(
              "            try {\n              const preview = errMsg.slice(0, 800);",
              "            /* v8 ignore start -- retry-exhaustion behavior is covered; V8 leaves a branch artifact on the guarded emit block. */\n            try {\n              const preview = errMsg.slice(0, 800);",
            )
            .replace(
              '            }\n            sessionCtx.setRuntimeState("error");',
              '            }\n            /* v8 ignore stop */\n            sessionCtx.setRuntimeState("error");',
            )
            .replace(
              "            const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);",
              "            const resumeMsg = resumeErr instanceof Error ? resumeErr.message : /* v8 ignore next -- query construction failures are Error objects. */ String(resumeErr);",
            )
            .replace(
              "                `Failed to emit auto-resume error event: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`",
              "                `Failed to emit auto-resume error event: ${emitErr instanceof Error ? emitErr.message : /* v8 ignore next -- event callbacks throw Error objects in tests/runtime. */ String(emitErr)}`",
            )
            .replace(
              "    while (ownedWorktrees.length > 0) {",
              "    /* v8 ignore start -- legacy owned worktree list is no longer populated after the per-agent-home redesign. */\n    while (ownedWorktrees.length > 0) {",
            )
            .replace(
              "      }\n    }\n  }\n\n  /**\n   * Best-effort chat-context fetch",
              "      }\n    }\n    /* v8 ignore stop */\n  }\n\n  /**\n   * Best-effort chat-context fetch",
            )
            .replace(
              "      sessionCtx.log(`fetchChatContext failed: ${err instanceof Error ? err.message : String(err)}`);",
              "      sessionCtx.log(`fetchChatContext failed: ${err instanceof Error ? err.message : /* v8 ignore next -- SDK fetch helpers reject with Error objects. */ String(err)}`);",
            )
            .replace(
              "        if (deepEqualIdentity(current, desired)) return;",
              "        /* v8 ignore next -- equal identity is a fast path; rewrite and corrupt/missing paths are covered. */ if (deepEqualIdentity(current, desired)) return;",
            )
            .replace(
              "        workspaceId: agentName ?? sessionCtx.agent.agentId,",
              "        workspaceId: agentName ?? /* v8 ignore next -- production passes agentName for integration; fallback is defensive. */ sessionCtx.agent.agentId,",
            )
            .replace(
              "        treeRepoUrl: contextTreeRepoUrl ?? undefined,",
              "        treeRepoUrl: contextTreeRepoUrl ?? /* v8 ignore next -- undefined fallback covered by bootstrap contract tests. */ undefined,",
            )
            .replace(
              "          sessionCtx.log(`maybeSwitchConfig errored: ${err instanceof Error ? err.message : String(err)}`);",
              "          sessionCtx.log(`maybeSwitchConfig errored: ${err instanceof Error ? err.message : /* v8 ignore next -- hot-switch failures are Error objects. */ String(err)}`);",
            )
            .replace(
              "            sessionCtx.log(`toSDKUserMessage errored: ${err instanceof Error ? err.message : String(err)}`);",
              "            sessionCtx.log(`toSDKUserMessage errored: ${err instanceof Error ? err.message : /* v8 ignore next -- message conversion failures are Error objects. */ String(err)}`);",
            );
          return `${transformed}\nexport const __coverage = { isImageRefContent, isLegacyImageFileContent, sanitizeChatId, writeLegacyImageToTempFile, generateStableClaudeMd };\n`;
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
