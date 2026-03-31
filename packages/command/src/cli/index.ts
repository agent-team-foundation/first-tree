#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { registerAdminCommands } from "../commands/admin.js";
import { registerAgentCommands } from "../commands/agent.js";
import { registerBindCommands } from "../commands/bind.js";
import { registerChatsCommand } from "../commands/chats.js";
import { registerClientCommands } from "../commands/client.js";
import { registerConfigCommands } from "../commands/config.js";
import { registerDbCommands } from "../commands/db.js";
import { registerFeishuCommands } from "../commands/feishu.js";
import { registerHistoryCommand } from "../commands/history.js";
import { registerOnboardCommand } from "../commands/onboard.js";
import { registerSendCommand } from "../commands/send.js";
import { registerServerCommands } from "../commands/server.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerTokenCommands } from "../commands/token.js";
import { registerConnectCommand } from "./connect.js";
import { registerStartCommand } from "./start.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

const program = new Command();

program
  .name("first-tree-hub")
  .description("First Tree Hub — centralized collaboration platform for agent teams")
  .version(version);

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

// Onboarding + self-service commands
registerOnboardCommand(program);
registerTokenCommands(program);
registerFeishuCommands(program);
registerBindCommands(program);

// Messaging commands (send, chats, history) — at top level
registerSendCommand(program);
registerChatsCommand(program);
registerHistoryCommand(program);

program.parse();
