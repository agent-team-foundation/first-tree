#!/usr/bin/env node

import { applyClientLoggerConfig } from "@first-tree/client";
import { Command } from "commander";
import { registerAgentCommands } from "../commands/agent/index.js";
import { registerChatCommands } from "../commands/chat/index.js";
import { registerConfigCommands } from "../commands/config/index.js";
import { registerDaemonCommands } from "../commands/daemon/index.js";
import { registerDoctorCommand } from "../commands/doctor.js";
import { registerGithubCommands } from "../commands/github/index.js";
import { registerLoginCommand } from "../commands/login.js";
import { registerLogoutCommand } from "../commands/logout.js";
import { registerOrgCommands } from "../commands/org/index.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerTreeCommands } from "../commands/tree/index.js";
import { registerUpgradeCommand } from "../commands/upgrade.js";
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
  .name("first-tree")
  .description("First Tree — Context Tree, GitHub Scan, and Hub agent collaboration in one CLI")
  .version(COMMAND_VERSION)
  .option("--json", "emit only machine-readable JSON on stdout; silence human status lines on stderr")
  .option("--verbose", "raise log level to debug (overrides FIRST_TREE_LOG_LEVEL)")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.optsWithGlobals<{ json?: boolean; verbose?: boolean }>();
    const json = opts.json === true || process.env.FIRST_TREE_JSON === "1";
    setJsonMode(json);

    // Log-level precedence: --verbose > FIRST_TREE_LOG_LEVEL > mode default.
    // One-shot commands are noisy by default, so human mode defaults to `warn`,
    // json mode to `error` — script consumers should get nothing on stderr
    // unless something actually broke.
    if (opts.verbose) {
      applyClientLoggerConfig({ level: "debug", explicit: true });
    } else if (process.env.FIRST_TREE_LOG_LEVEL) {
      // Env var already applied at logger init; re-pin as explicit so later
      // config-driven applies (daemon start reading client.yaml) can't
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

// ── Top-level shortcuts (single-command verbs) ──────────────────────────

registerLoginCommand(program);
registerLogoutCommand(program);
registerStatusCommand(program);
registerDoctorCommand(program);
registerUpgradeCommand(program);

// ── Namespaces ─────────────────────────────────────────────────────────

registerAgentCommands(program);
registerChatCommands(program);
registerOrgCommands(program);
registerDaemonCommands(program);
registerConfigCommands(program);

registerTreeCommands(program);
registerGithubCommands(program);

program.parse();
