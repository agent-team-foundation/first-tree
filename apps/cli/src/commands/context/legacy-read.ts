import { print } from "../../core/output.js";
import type { CommandContext, SubcommandModule } from "../types.js";

export function runLegacyContextRead(_context: CommandContext): void {
  print.fail(
    "CONTEXT_PLUGIN_RELOAD_REQUIRED",
    "This Context read entrypoint was retired. Reload the First Tree Context Plugin, then use the current task Skill.",
    2,
    { nextActions: ["Reload the First Tree Context Plugin, then retry through its current thin Skill."] },
  );
}

export const legacyContextReadCommand: SubcommandModule = {
  name: "read",
  hidden: true,
  alias: "",
  summary: "",
  description: "Retired external Context read entrypoint.",
  action: runLegacyContextRead,
};
