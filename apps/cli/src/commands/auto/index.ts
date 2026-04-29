import type { Command } from "commander";

import type { CommandModule } from "../types.js";

export const autoCommand: CommandModule = {
  name: "auto",
  description: "Run auto workflow commands.",
  register(program: Command): void {
    const command = program
      .command("auto")
      .description("Run auto workflow commands.")
      .argument("[args...]", "auto sub-command and its arguments")
      .allowUnknownOption(true)
      .helpOption(false)
      .helpCommand(false)
      .action(async (_args: string[]) => {
        const { runAuto } = await import("@first-tree/auto");
        const exitCode = await runAuto(command.args);
        if (typeof exitCode === "number" && exitCode !== 0) {
          process.exitCode = exitCode;
        }
      });
  },
};
