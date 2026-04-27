import type { SubcommandModule } from "../types.js";

export function runInstallClaudeCodeHookCommand(): void {
  console.log("first-tree tree install-claude-code-hook is not implemented yet.");
}

export const installClaudeCodeHookCommand: SubcommandModule = {
  name: "install-claude-code-hook",
  alias: "",
  summary: "",
  description: "Install the Claude Code hook for first-tree workflows.",
  action: runInstallClaudeCodeHookCommand,
};
