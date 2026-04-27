import type { SubcommandModule } from "../types.js";

export function runStatusCommand(): void {
  console.log("first-tree gardener status is not implemented yet.");
}

export const statusCommand: SubcommandModule = {
  name: "status",
  description: "Show gardener-managed state status.",
  action: runStatusCommand,
};
