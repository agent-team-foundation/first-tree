#!/usr/bin/env node

import { Command } from "commander";
import { registerAdminCommands } from "../commands/admin.js";
import { registerAgentCommands } from "../commands/agent.js";
import { registerClientCommands } from "../commands/client.js";
import { registerConfigCommands } from "../commands/config.js";
import { registerDbCommands } from "../commands/db.js";
import { registerServerCommands } from "../commands/server.js";
import { registerStatusCommand } from "../commands/status.js";

const program = new Command();

program
  .name("agent-hub")
  .description("Agent Hub — centralized collaboration platform for agent teams")
  .version("0.1.0");

// Command groups
registerServerCommands(program);
registerClientCommands(program);
registerDbCommands(program);
registerAdminCommands(program);
registerConfigCommands(program);
registerStatusCommand(program);

// Legacy agent commands (register, pull) — at top level
registerAgentCommands(program);

program.parse();
