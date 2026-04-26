import type { SubcommandModule } from "../types.js";

export const generateCodeownersCommand: SubcommandModule = {
  name: "generate-codeowners",
  description: "Generate CODEOWNERS entries from first-tree ownership data.",
};
