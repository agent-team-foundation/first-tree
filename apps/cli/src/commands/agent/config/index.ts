import type { Command } from "commander";
import { registerAgentConfigAddMcpCommand } from "./add-mcp.js";
import { registerAgentConfigAddRepoCommand } from "./add-repo.js";
import { registerAgentConfigCapabilitiesCommands } from "./capabilities.js";
import { registerAgentConfigDryRunCommand } from "./dry-run.js";
import { registerAgentConfigAppendPromptCommand, registerAgentConfigPromptCommands } from "./prompt.js";
import { registerAgentConfigSetEnvCommand } from "./set-env.js";
import { registerAgentConfigSetModelCommand } from "./set-model.js";
import { registerAgentConfigSetReasoningEffortCommand } from "./set-reasoning-effort.js";
import { registerAgentConfigShowCommand } from "./show.js";

/**
 * `<binName> agent config ...` — admin-API-backed runtime configuration
 * (model / prompt / MCP / env / repos / dry-run). Mounted under the parent
 * `agent` namespace so the surface stays `<binName> agent config <verb>`.
 */
export function registerAgentConfigCommands(parent: Command): void {
  const config = parent.command("config").description("Manage agent runtime configuration (Step 8)");
  registerAgentConfigShowCommand(config);
  registerAgentConfigSetModelCommand(config);
  registerAgentConfigSetReasoningEffortCommand(config);
  registerAgentConfigPromptCommands(config);
  registerAgentConfigAppendPromptCommand(config);
  registerAgentConfigAddMcpCommand(config);
  registerAgentConfigSetEnvCommand(config);
  registerAgentConfigAddRepoCommand(config);
  registerAgentConfigCapabilitiesCommands(config);
  registerAgentConfigDryRunCommand(config);
}
