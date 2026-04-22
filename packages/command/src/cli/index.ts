#!/usr/bin/env node

import { Command } from "commander";
import { registerAgentCommands } from "../commands/agent.js";
import { registerClientCommands } from "../commands/client.js";
import { registerConfigCommands } from "../commands/config.js";
import { registerOnboardCommand } from "../commands/onboard.js";
import { registerServerCommands } from "../commands/server.js";
import { registerStatusCommand } from "../commands/status.js";
import { COMMAND_VERSION } from "../core/version.js";

const program = new Command();

program
  .name("first-tree-hub")
  .description("First Tree Hub — centralized collaboration platform for agent teams")
  .version(COMMAND_VERSION);

// Core subsystems — `client` group mounts `connect` too.
registerServerCommands(program);
registerClientCommands(program);

// Agent management (config, tokens, bindings, messaging)
registerAgentCommands(program);

// Configuration
registerConfigCommands(program);

// Global status overview
registerStatusCommand(program);

// Onboarding
registerOnboardCommand(program);

program.parse();
