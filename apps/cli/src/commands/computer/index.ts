import type { Command } from "commander";
import { channelConfig } from "../../core/channel.js";
import { runLogout } from "../logout.js";

export function registerComputerCommands(program: Command): void {
  const computer = program.command("computer").description("Manage this computer's local First Tree client state");

  computer
    .command("reset")
    .description("Stop the daemon and remove this computer's local client state")
    .action(() => {
      runLogout({ purge: true, retryCommand: `${channelConfig.binName} computer reset` });
    });
}
