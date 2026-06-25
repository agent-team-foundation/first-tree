import { registerHandler } from "../runtime/handler.js";
import { createClaudeCodeHandler } from "./claude-code.js";
import { createClaudeCodeTuiHandler } from "./claude-code-tui/index.js";
import { type ClaudeExecutableResolution, resolveClaudeCodeExecutable } from "./claude-executable.js";
import { createCodexHandler } from "./codex/index.js";

/** Injectable seam so tests can force a Claude-executable resolution (no real PATH / shell spawn). */
export type RegisterBuiltinHandlersDeps = {
  resolveExecutable?: () => ClaudeExecutableResolution;
};

/** Register all built-in handlers. Call once at startup. */
export function registerBuiltinHandlers(deps: RegisterBuiltinHandlersDeps = {}): void {
  // Registration runs synchronously in the ClientRuntime constructor, BEFORE the
  // WS connects — so it must not block. Resolve cheap-only (`includeLoginShell:
  // false`): daemon PATH + well-known dirs, never a login-shell `spawnSync`. A
  // `claude` that lives only on the user's interactive shell PATH resolves to
  // `undefined` here and is picked up lazily by the handler at session start
  // (which re-resolves with the login-shell probe) and by the capability probe
  // (post-registration) — neither of which is on the pre-connect path.
  const resolution = (deps.resolveExecutable ?? (() => resolveClaudeCodeExecutable({ includeLoginShell: false })))();
  if (resolution.path) {
    process.stderr.write(`[handlers] Claude Code executable: ${resolution.path} (source=${resolution.source})\n`);
  } else {
    process.stderr.write(
      "[handlers] Claude Code executable: using SDK bundled native binary (set CLAUDE_CODE_EXECUTABLE or install `claude` on PATH to override)\n",
    );
  }
  registerHandler("claude-code", (config) =>
    createClaudeCodeHandler({ ...config, claudeCodeExecutable: resolution.path }),
  );
  // claude-code-tui: drives the Claude Code TUI through tmux. Replaces the
  // SDK-based handler for the post-SDK-sunset world. Requires `tmux` >= 3.0
  // and `claude` resolvable on PATH (capability probe in
  // `runtime/capabilities/claude-code-tui.ts` enforces both).
  registerHandler("claude-code-tui", (config) =>
    createClaudeCodeTuiHandler({ ...config, claudeCodeExecutable: resolution.path }),
  );
  // Codex SDK bundles the codex CLI binary inside the npm package — no PATH
  // resolution needed. The handler factory consumes the same HandlerConfig
  // (workspaceRoot / agentConfigCache / contextTreePath).
  registerHandler("codex", (config) => createCodexHandler(config));
}
