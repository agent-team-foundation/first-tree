import type { Command } from "commander";
import { registerDaemonDoctorCommand } from "./doctor.js";
import { registerDaemonRestartCommand } from "./restart.js";
import { registerDaemonStartCommand } from "./start.js";
import { registerDaemonStatusCommand } from "./status.js";
import { registerDaemonStopCommand } from "./stop.js";

export function registerDaemonCommands(program: Command): void {
  const daemon = program.command("daemon").description("Background daemon — runs all configured agents on this machine");
  registerDaemonStartCommand(daemon);
  registerDaemonStopCommand(daemon);
  registerDaemonRestartCommand(daemon);
  registerDaemonStatusCommand(daemon);
  registerDaemonDoctorCommand(daemon);
}
