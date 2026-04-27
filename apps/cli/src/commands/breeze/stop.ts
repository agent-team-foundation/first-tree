import type { SubcommandModule } from "../types.js";

export function runStopCommand(): void {
  console.log("first-tree breeze stop is not implemented yet.");
}

export const stopCommand: SubcommandModule = {
  name: "stop",
  alias: "",
  summary: "",
  description: "Stop breeze workflow services.",
  action: runStopCommand,
};
