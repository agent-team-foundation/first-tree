import type { SubcommandModule } from "../types.js";

export function runSyncCommand(): void {
  console.log("first-tree gardener sync is not implemented yet.");
}

export const syncCommand: SubcommandModule = {
  name: "sync",
  description: "Sync gardener-managed state.",
  action: runSyncCommand,
};
