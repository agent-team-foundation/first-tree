import { registerHandler } from "../runtime/handler.js";
import { createClaudeCodeHandler } from "./claude-code.js";
import { createClaudeCodeTuiHandler } from "./claude-code-tui/index.js";
import { resolveClaudeCodeExecutable } from "./claude-executable.js";
import { createCodexHandler } from "./codex.js";

/** Register all built-in handlers. Call once at startup. */
export function registerBuiltinHandlers(): void {
  const resolution = resolveClaudeCodeExecutable();
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
