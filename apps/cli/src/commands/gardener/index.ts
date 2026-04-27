import type { Command } from "commander";

import type { CommandModule, SubcommandModule } from "../types.js";
import { registerCommandGroup } from "../groups.js";
import { installCommand } from "./install.js";
import { statusCommand } from "./status.js";
import { syncCommand } from "./sync.js";

const gardenerSubcommands: SubcommandModule[] = [syncCommand, statusCommand, installCommand];

export const gardenerCommand: CommandModule = {
  name: "gardener",
  description: "Work with gardener workflow commands.",
  register(program: Command): void {
    registerCommandGroup(
      program,
      "gardener",
      "Work with gardener workflow commands.",
      gardenerSubcommands,
    );
  },
};
