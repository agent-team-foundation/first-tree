import type { Command } from "commander";
import { print } from "../../core/output.js";
import type { CommandContext, SubcommandModule } from "../types.js";

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>")
    .requiredOption("--adapter-digest <digest>")
    .requiredOption("--adoption-generation <generation>");
}

/**
 * Adapter 1.0.1 may remain loaded in an existing Claude session after the CLI
 * upgrades. Keep its retired UserPromptSubmit command harmless until that
 * session ends, without issuing receipts or mutating adoption state.
 */
export function runContextObserveLoaded(_context: CommandContext): void {
  print.hook({ continue: true });
}

export const contextObserveLoadedCommand: SubcommandModule = {
  name: "observe-loaded",
  hidden: true,
  alias: "",
  summary: "",
  description: "Retired Claude same-session lifecycle bridge.",
  configure,
  action: runContextObserveLoaded,
};
