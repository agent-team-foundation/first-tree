#!/usr/bin/env node

import { Command } from "commander";
import { registerAdminCommands } from "../commands/admin.js";
import { registerAgentCommands } from "../commands/agent.js";
import { registerChatsCommand } from "../commands/chats.js";
import { registerClientCommands } from "../commands/client.js";
import { registerConfigCommands } from "../commands/config.js";
import { registerDbCommands } from "../commands/db.js";
import { registerHistoryCommand } from "../commands/history.js";
import { registerSendCommand } from "../commands/send.js";
import { registerServerCommands } from "../commands/server.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerConnectCommand } from "./connect.js";
import { registerStartCommand } from "./start.js";

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

// Agent runtime commands (from PR #18 — connect single agent, start multi-agent runtime)
registerConnectCommand(program);
registerStartCommand(program);

// Legacy agent commands (register, pull) — at top level
registerAgentCommands(program);

// Messaging commands (send, chats, history) — at top level
registerSendCommand(program);
registerChatsCommand(program);
registerHistoryCommand(program);

program.parse();
