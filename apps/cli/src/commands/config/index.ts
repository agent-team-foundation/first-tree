import type { Command } from "commander";
import { registerConfigGetCommand } from "./get.js";
import { registerConfigSetCommand } from "./set.js";
import { registerConfigShowCommand } from "./show.js";

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("View and modify this machine's client.yaml");
  registerConfigShowCommand(config);
  registerConfigSetCommand(config);
  registerConfigGetCommand(config);
}
