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
  CURSOR: "cursor",
} as const;

export const runtimeProviderSchema = z.enum(["claude-code", "claude-code-tui", "codex", "cursor"]);
export type RuntimeProvider = z.infer<typeof runtimeProviderSchema>;

export const DEFAULT_RUNTIME_PROVIDER: RuntimeProvider = "claude-code";

/**
 * Runtime providers temporarily disabled platform-wide. A disabled provider is
 * filtered out of UI runtime selection (creating agents, onboarding, the client
 * setup/ready cards) and skipped by the client capability probe, so it is
 * neither offered to users nor advertised / re-probed by the daemon. The
 * provider stays a valid `RuntimeProvider` so already-bound agents keep their
 * label and continue to run — this only hides it from new selection + detection.
 *
 * Empty = nothing disabled. To re-enable a provider, remove it from this list
 * (single-line revert).
 */
export const DISABLED_RUNTIME_PROVIDERS: readonly RuntimeProvider[] = ["claude-code-tui"];

/** True when `provider` is not temporarily disabled (see {@link DISABLED_RUNTIME_PROVIDERS}). */
export function isRuntimeProviderEnabled(provider: string): boolean {
  return !DISABLED_RUNTIME_PROVIDERS.some((p) => p === provider);
}
