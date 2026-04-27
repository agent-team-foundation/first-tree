import type { SubcommandModule } from "../types.js";

export function runInstallCommand(): void {
  console.log("first-tree gardener install is not implemented yet.");
}

export const installCommand: SubcommandModule = {
  name: "install",
  description: "Install gardener workflow support.",
  action: runInstallCommand,
};
