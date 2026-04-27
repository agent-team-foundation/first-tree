import type { SubcommandModule } from "../types.js";

export function runStatusCommand(): void {
  console.log("first-tree hub status is not implemented yet.");
}

export const statusCommand: SubcommandModule = {
  name: "status",
  alias: "",
  summary: "",
  description: "Show hub status.",
  action: runStatusCommand,
};
