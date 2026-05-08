import type { Command } from "commander";

import type { CommandContext, SubcommandModule } from "../types.js";
import { generateCodeowners } from "./codeowners.js";

export const GENERATE_CODEOWNERS_USAGE = `usage: first-tree tree generate-codeowners [--check] [--always-include <handles...>]

Generate \`.github/CODEOWNERS\` from the Context Tree's NODE.md ownership
frontmatter. Walks the tree, resolves owners with parent inheritance, and
writes the file.

Options:
  --check                       Exit non-zero if CODEOWNERS is out-of-date (do not write)
  --always-include <handles...> Owner handles to append to every CODEOWNERS entry.
                                Accepts GitHub user logins or App slugs, with or
                                without a leading \`@\` (e.g. \`first-tree-gate\`).
  --help                        Show this help message`;

function configureGenerateCodeownersCommand(command: Command): void {
  command.option("--check", "exit non-zero if CODEOWNERS is out-of-date");
  command.option(
    "--always-include <handles...>",
    "owner handles to append to every CODEOWNERS entry",
  );
}

export function runGenerateCodeownersCommand(context: CommandContext): void {
  const options = context.command.opts() as {
    check?: boolean;
    alwaysInclude?: string[];
  };
  const exitCode = generateCodeowners(process.cwd(), {
    check: options.check === true,
    alwaysInclude: options.alwaysInclude,
  });
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

export const generateCodeownersCommand: SubcommandModule = {
  name: "generate-codeowners",
  alias: "",
  summary: "",
  description: "Generate CODEOWNERS entries from first-tree ownership data.",
  configure: configureGenerateCodeownersCommand,
  action: runGenerateCodeownersCommand,
};
