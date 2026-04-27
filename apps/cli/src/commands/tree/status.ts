import type { SubcommandModule } from "../types.js";

export function runStatusCommand(): void {
  console.log("first-tree tree status is not implemented yet.");
}

export const statusCommand: SubcommandModule = {
  name: "status",
  description: "Show first-tree workspace status.",
  action: runStatusCommand,
};
