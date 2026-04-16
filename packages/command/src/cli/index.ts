#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";
import { registerAgentCommands } from "../commands/agent.js";
import { registerClientCommands } from "../commands/client.js";
import { registerConfigCommands } from "../commands/config.js";
import { registerConnectCommand } from "../commands/connect.js";
import { registerOnboardCommand } from "../commands/onboard.js";
import { registerServerCommands } from "../commands/server.js";
import { registerStatusCommand } from "../commands/status.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

const program = new Command();

program
  .name("first-tree-hub")
  .description("First Tree Hub — centralized collaboration platform for agent teams")
  .version(version);

// Core subsystems
registerServerCommands(program);
registerClientCommands(program);

// Agent management (config, tokens, bindings, messaging)
registerAgentCommands(program);

// Configuration
registerConfigCommands(program);

// Global status overview
registerStatusCommand(program);

// Connect (first-time setup)
registerConnectCommand(program);

// Onboarding
registerOnboardCommand(program);

program.parse();
