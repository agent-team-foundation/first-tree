import type { Command } from "commander";
import { registerAgentConfigAddMcpCommand } from "./add-mcp.js";
import { registerAgentConfigAddRepoCommand } from "./add-repo.js";
import { registerAgentConfigAppendPromptCommand } from "./append-prompt.js";
import { registerAgentConfigDryRunCommand } from "./dry-run.js";
import { registerAgentConfigSetEnvCommand } from "./set-env.js";
import { registerAgentConfigSetModelCommand } from "./set-model.js";
import { registerAgentConfigShowCommand } from "./show.js";

/**
 * `first-tree agent config ...` — admin-API-backed runtime configuration
 * (model / prompt / MCP / env / repos / dry-run). Mounted under the parent
 * `agent` namespace so the surface stays `first-tree agent config <verb>`.
 */
export function registerAgentConfigCommands(parent: Command): void {
  const config = parent.command("config").description("Manage agent runtime configuration (Step 8)");
  registerAgentConfigShowCommand(config);
  registerAgentConfigSetModelCommand(config);
  registerAgentConfigAppendPromptCommand(config);
  registerAgentConfigAddMcpCommand(config);
  registerAgentConfigSetEnvCommand(config);
  registerAgentConfigAddRepoCommand(config);
  registerAgentConfigDryRunCommand(config);
}
