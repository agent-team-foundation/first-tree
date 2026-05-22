import type { Command } from "commander";

import type { CommandContext, SubcommandModule } from "../types.js";
import { ensureAgentContextHooks, formatAgentContextHookMessages } from "./agent-context-hooks.js";

function configureClaudeHookCommand(command: Command): void {
  command.option("--root <path>", "operate on a different root (default: cwd)");
}

export function runClaudeHookCommand(context: CommandContext): void {
  const options = context.command.opts() as { root?: string };
  const targetRoot = options.root ?? process.cwd();
  const result = ensureAgentContextHooks(targetRoot);
  const messages = formatAgentContextHookMessages(result);

  if (context.options.json) {
    console.log(JSON.stringify({ result, targetRoot }, null, 2));
    return;
  }

  if (messages.length === 0) {
    console.log("Managed Claude Code and Codex SessionStart hooks are already current.");
    return;
  }

  for (const message of messages) {
    console.log(message);
  }
}

export const claudeHookCommand: SubcommandModule = {
  name: "claude-hook",
  alias: "",
  summary: "",
  description: "Install the Claude Code hook for first-tree workflows.",
  configure: configureClaudeHookCommand,
  action: runClaudeHookCommand,
};
