import type { SubcommandModule } from "../types.js";

export function runStartCommand(): void {
  console.log("first-tree hub start is not implemented yet.");
}

export const startCommand: SubcommandModule = {
  name: "start",
  description: "Start hub services.",
  action: runStartCommand,
};
