import type { Command } from "commander";
import { registerDaemonDoctorCommand } from "./doctor.js";
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
  // Hidden — supervisor-cooperation interface invoked by `createExecuteUpdate`
  // after a self-install to refresh the unit file with the new binary's
  // templates before exit(75).
  registerDaemonRefreshUnitCommand(daemon);
}
