import type { ContextIntegrationProvider } from "@first-tree/shared";
import type { ContextIntegrationProviderDriver } from "./provider-driver.js";
import { ClaudeCodeContextIntegrationDriver } from "./providers/claude-code.js";
import { CodexContextIntegrationDriver } from "./providers/codex.js";

export function createContextIntegrationProviderDriver(
  provider: ContextIntegrationProvider,
): ContextIntegrationProviderDriver {
  return provider === "claude-code" ? new ClaudeCodeContextIntegrationDriver() : new CodexContextIntegrationDriver();
}
