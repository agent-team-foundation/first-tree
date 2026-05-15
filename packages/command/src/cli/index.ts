#!/usr/bin/env node

import { applyClientLoggerConfig } from "@first-tree-hub/client";
import { Command } from "commander";
import { registerAgentCommands } from "../commands/agent.js";
import { registerChatCommands } from "../commands/chat.js";
import { registerClientCommands } from "../commands/client.js";
import { registerOnboardCommand } from "../commands/onboard.js";
import { registerOrgCommands } from "../commands/org.js";
import { registerSaaSConnectCommand } from "../commands/saas-connect.js";
import { registerUpdateCommand } from "../commands/update.js";
import { runHomeMigration } from "../core/migrate-home.js";
import { setJsonMode } from "../core/output.js";
import { COMMAND_VERSION } from "../core/version.js";

// Run once at startup, BEFORE any command touches config/credentials so the
// very first CLI invocation on an upgraded install transparently picks up
// the renamed `~/.first-tree/hub` home. Never throws — failures degrade to
// a stderr warning and the CLI still runs.
runHomeMigration();

const program = new Command();

program
  .name("first-tree-hub")
  .description("First Tree Hub — centralized collaboration platform for agent teams")
  .version(COMMAND_VERSION)
  .option("--json", "emit only machine-readable JSON on stdout; silence human status lines on stderr")
  .option("--verbose", "raise log level to debug (overrides FIRST_TREE_HUB_LOG_LEVEL)")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.optsWithGlobals<{ json?: boolean; verbose?: boolean }>();
    const json = opts.json === true || process.env.FIRST_TREE_HUB_JSON === "1";
    setJsonMode(json);

    // Log-level precedence: --verbose > FIRST_TREE_HUB_LOG_LEVEL > mode default.
    // One-shot commands are noisy by default, so human mode defaults to `warn`,
    // json mode to `error` — script consumers should get nothing on stderr
    // unless something actually broke.
    if (opts.verbose) {
      applyClientLoggerConfig({ level: "debug", explicit: true });
    } else if (process.env.FIRST_TREE_HUB_LOG_LEVEL) {
      // Env var already applied at logger init; re-pin as explicit so later
      // config-driven applies (client start reading client.yaml) can't
      // override what the operator explicitly asked for.
      applyClientLoggerConfig({ explicit: true });
    } else if (json) {
      // --json is an operator choice; pin the level so downstream commands
      // can't re-introduce info/debug noise on stderr from their saved config.
      applyClientLoggerConfig({ level: "error", explicit: true });
    } else {
      applyClientLoggerConfig({ level: "warn" });
    }
  });

// Top-level `connect <token>` — single entry point. Hub URL is derived from
// the token's `iss` claim, so users only paste the token.
registerSaaSConnectCommand(program);

// Core subsystems
registerClientCommands(program);

// Agent management (config, bindings, lifecycle)
registerAgentCommands(program);

// Chats and messaging
registerChatCommands(program);

// Self-update — user-triggered upgrade + service restart.
registerUpdateCommand(program);

// Onboarding
registerOnboardCommand(program);

// Organization-level operations (e.g. set tree URL during Step 3)
registerOrgCommands(program);

program.parse();
