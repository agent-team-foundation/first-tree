import type { SubcommandModule } from "../types.js";

export function runInspectCommand(): void {
  console.log("first-tree tree inspect is not implemented yet.");
}

export const inspectCommand: SubcommandModule = {
  name: "inspect",
  description: "Inspect the first-tree workspace.",
  action: runInspectCommand,
};
