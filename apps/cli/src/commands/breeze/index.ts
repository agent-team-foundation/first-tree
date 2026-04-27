import type { Command } from "commander";

import type { CommandModule, SubcommandModule } from "../types.js";
import { registerCommandGroup } from "../groups.js";
import { doctorCommand } from "./doctor.js";
import { installCommand } from "./install.js";
import { pollCommand } from "./poll.js";
import { startCommand } from "./start.js";
import { statusCommand } from "./status.js";
import { stopCommand } from "./stop.js";

const breezeSubcommands: SubcommandModule[] = [
  installCommand,
  startCommand,
  stopCommand,
  statusCommand,
  doctorCommand,
  pollCommand,
];

export const breezeCommand: CommandModule = {
  name: "breeze",
  description: "Work with breeze workflow commands.",
  register(program: Command): void {
    registerCommandGroup(
      program,
      "breeze",
      "Work with breeze workflow commands.",
      breezeSubcommands,
    );
  },
};
