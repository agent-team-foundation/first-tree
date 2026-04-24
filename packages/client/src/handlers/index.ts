import { registerHandler } from "../runtime/handler.js";
import { createClaudeCodeHandler } from "./claude-code.js";
import { resolveClaudeCodeExecutable } from "./claude-executable.js";

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
}
