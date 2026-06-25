import type { Command } from "commander";
import { registerDaemonDoctorCommand } from "./doctor.js";
import { registerDaemonHomeInfoCommand } from "./home-info.js";
import { registerDaemonInstallCodexCommand } from "./install-codex.js";
import { registerDaemonProbeCommand } from "./probe.js";
import { registerDaemonRefreshUnitCommand } from "./refresh-unit.js";
import { registerDaemonRestartCommand } from "./restart.js";
import { registerDaemonStartCommand } from "./start.js";
import { registerDaemonStatusCommand } from "./status.js";
import { registerDaemonStopCommand } from "./stop.js";

export function registerDaemonCommands(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("Background daemon — runs all configured agents on this machine");
  registerDaemonStartCommand(daemon);
  registerDaemonStopCommand(daemon);
  registerDaemonRestartCommand(daemon);
  registerDaemonStatusCommand(daemon);
  registerDaemonDoctorCommand(daemon);
  registerDaemonProbeCommand(daemon);
  registerDaemonInstallCodexCommand(daemon);
  // Hidden — supervisor-cooperation interface invoked by `createExecuteUpdate`
  // after a self-install to refresh the unit file with the new binary's
  // templates before exit(75).
  registerDaemonRefreshUnitCommand(daemon);
  // Hidden — post-bundle test probe; emits resolved channel identity +
  // home paths as JSON. See `apps/cli/src/__tests__/post-bundle-channel-home.test.ts`.
  registerDaemonHomeInfoCommand(daemon);
}
