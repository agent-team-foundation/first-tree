import { z } from "zod";

/**
 * Runtime provider — which LLM CLI runtime drives an agent. New providers
 * extend the union here, then register a handler factory and capability
 * probe module on the client side.
 */
export const RUNTIME_PROVIDERS = {
  CLAUDE_CODE: "claude-code",
  CLAUDE_CODE_TUI: "claude-code-tui",
  CODEX: "codex",
} as const;

export const runtimeProviderSchema = z.enum(["claude-code", "claude-code-tui", "codex"]);
export type RuntimeProvider = z.infer<typeof runtimeProviderSchema>;

export const DEFAULT_RUNTIME_PROVIDER: RuntimeProvider = "claude-code";
