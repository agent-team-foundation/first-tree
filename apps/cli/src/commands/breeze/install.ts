import type { SubcommandModule } from "../types.js";

export function runInstallCommand(): void {
  console.log("first-tree breeze install is not implemented yet.");
}

export const installCommand: SubcommandModule = {
  name: "install",
  description: "Install breeze workflow support.",
  action: runInstallCommand,
};
