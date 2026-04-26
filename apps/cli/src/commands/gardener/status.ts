import type { SubcommandModule } from "../types.js";

export const statusCommand: SubcommandModule = {
  name: "status",
  description: "Show gardener-managed state status.",
};
