import type { SubcommandModule } from "../types.js";

export function runStopCommand(): void {
  console.log("first-tree hub stop is not implemented yet.");
}

export const stopCommand: SubcommandModule = {
  name: "stop",
  description: "Stop hub services.",
  action: runStopCommand,
};
