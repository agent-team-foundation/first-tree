import type { SubcommandModule } from "../types.js";

export function runGenerateCodeownersCommand(): void {
  console.log("first-tree tree generate-codeowners is not implemented yet.");
}

export const generateCodeownersCommand: SubcommandModule = {
  name: "generate-codeowners",
  alias: "",
  summary: "",
  description: "Generate CODEOWNERS entries from first-tree ownership data.",
  action: runGenerateCodeownersCommand,
};
