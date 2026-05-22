import type { CommandContext, SubcommandModule } from "../types.js";

import { runInspectCommand } from "./inspect.js";

export function runStatusCommand(context: CommandContext): void {
  runInspectCommand(context);
}

export const statusCommand: SubcommandModule = {
  name: "status",
  alias: "",
  summary: "",
  description: "Show first-tree workspace status.",
  action: runStatusCommand,
};
