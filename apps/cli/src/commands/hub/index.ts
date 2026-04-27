import type { Command } from "commander";

import type { CommandModule, SubcommandModule } from "../types.js";
import { registerCommandGroup } from "../groups.js";
import { doctorCommand } from "./doctor.js";
import { startCommand } from "./start.js";
import { statusCommand } from "./status.js";
import { stopCommand } from "./stop.js";

const hubSubcommands: SubcommandModule[] = [
  startCommand,
  stopCommand,
  doctorCommand,
  statusCommand,
];

export const hubCommand: CommandModule = {
  name: "hub",
  description: "Work with hub workflow commands.",
  register(program: Command): void {
    registerCommandGroup(program, "hub", "Work with hub workflow commands.", hubSubcommands);
  },
};
