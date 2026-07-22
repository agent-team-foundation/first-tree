#!/usr/bin/env node

// MUST be the first import: this side-effect module sets
// `process.env.FIRST_TREE_HOME` from the channel default AND installs the
// channel-resolved CLI binding into `@first-tree/client`, before any other
// module loads `@first-tree/shared/config` or instantiates ClientRuntime.
// Re-ordering this line after a config-touching or runtime-instantiating
// import re-introduces the multi-env footgun where staging/dev binaries
// silently fall back to the prod home and prod CLI name.
import "../core/channel-env.js";
import { applyClientLoggerConfig } from "@first-tree/client";
import { Command } from "commander";
import { registerAgentCommands } from "../commands/agent/index.js";
import { registerChatCommands } from "../commands/chat/index.js";
import { registerComputerCommands } from "../commands/computer/index.js";
import { registerConfigCommands } from "../commands/config/index.js";
import { registerDaemonCommands } from "../commands/daemon/index.js";
import { registerDocCommands } from "../commands/doc/index.js";
import { registerDoctorCommand } from "../commands/doctor.js";
import { registerGithubCommands } from "../commands/github/index.js";
import { registerGitlabCommands } from "../commands/gitlab/index.js";
import { registerLoginCommand } from "../commands/login.js";
import { registerLogoutCommand } from "../commands/logout.js";
import { registerOrgCommands } from "../commands/org/index.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerTreeCommands } from "../commands/tree/index.js";
import { registerUpgradeCommand } from "../commands/upgrade.js";
import { channelConfig } from "../core/channel.js";
import { retireLegacyGithubScanRunner } from "../core/legacy-github-scan.js";
import { setJsonMode } from "../core/output.js";
import { COMMAND_VERSION } from "../core/version.js";

const program = new Command();

program
  .name(channelConfig.binName)
  .description("First Tree — Context Tree and agent collaboration in one CLI")
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

    // One-shot housekeeping (issue #995): retire the pre-#775 legacy
    // github-scan launchd runner — bootout + plist removal, ending its
    // KeepAlive crash-loop and freeing port 7878. Runs before every command
    // so any "first run of a new version" path is covered (manual upgrade,
    // auto-update restart, daemon refresh-unit, non-daemon usage). Marker
    // gated: steady-state cost is a single existsSync. Never throws.
    retireLegacyGithubScanRunner();
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
registerComputerCommands(program);
registerDocCommands(program);
registerGithubCommands(program);
registerGitlabCommands(program);
registerOrgCommands(program);
registerDaemonCommands(program);
registerConfigCommands(program);

registerTreeCommands(program);

program.parse();
