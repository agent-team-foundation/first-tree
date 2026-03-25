import { registerHandler } from "../runtime/handler.js";
import { createClaudeCodeHandler } from "./claude-code.js";

/** Register all built-in handlers. Call once at startup. */
export function registerBuiltinHandlers(): void {
  registerHandler("claude-code", createClaudeCodeHandler);
}
