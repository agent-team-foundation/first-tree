import type { Command } from "commander";
import { registerAgentAddCommand } from "./add.js";
import { registerAgentBindCommands } from "./bind/index.js";
import { registerAgentCapabilityCommands } from "./capability.js";
import { registerAgentConfigCommands } from "./config/index.js";
import { registerAgentCreateCommand } from "./create.js";
import { registerAgentDebugCommands } from "./debug/index.js";
import { registerAgentListCommand } from "./list.js";
import { registerAgentPruneCommand } from "./prune.js";
import { registerAgentRemoveCommand } from "./remove.js";
import { registerAgentResetCommand } from "./reset.js";
import { registerAgentSessionCommands } from "./session/index.js";
import { registerAgentStatusCommand } from "./status.js";
import { registerAgentWorkspaceCommands } from "./workspace/index.js";

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Agent management — config, bindings, messaging");

  // Config sub-group goes first so it shows near the top of `agent --help`.
  registerAgentConfigCommands(agent);

  // Local alias + remote-record CRUD.
  registerAgentAddCommand(agent);
  registerAgentRemoveCommand(agent);
  registerAgentPruneCommand(agent);
  registerAgentListCommand(agent);

  // Remote agent lifecycle.
  registerAgentCreateCommand(agent);
  registerAgentCapabilityCommands(agent);

  // Workspace housekeeping.
  registerAgentWorkspaceCommands(agent);

  // Binding (machine).
  registerAgentBindCommands(agent);

  // Runtime status & control.
  registerAgentStatusCommand(agent);
  registerAgentResetCommand(agent);
  registerAgentSessionCommands(agent);

  // Hidden debug surface.
  registerAgentDebugCommands(agent);
}
