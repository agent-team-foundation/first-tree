import type { SubcommandModule } from "../types.js";

export const syncCommand: SubcommandModule = {
  name: "sync",
  description: "Sync gardener-managed state.",
};
