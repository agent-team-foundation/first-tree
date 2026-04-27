import type { SubcommandModule } from "../types.js";

export function runStatusCommand(): void {
  console.log("first-tree breeze status is not implemented yet.");
}

export const statusCommand: SubcommandModule = {
  name: "status",
  description: "Show breeze workflow status.",
  action: runStatusCommand,
};
