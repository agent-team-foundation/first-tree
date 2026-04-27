import type { SubcommandModule } from "../types.js";

export function runStartCommand(): void {
  console.log("first-tree breeze start is not implemented yet.");
}

export const startCommand: SubcommandModule = {
  name: "start",
  description: "Start breeze workflow services.",
  action: runStartCommand,
};
