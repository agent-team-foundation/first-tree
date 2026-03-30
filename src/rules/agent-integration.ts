import type { Repo } from "#src/repo.js";
import type { RuleResult } from "#src/rules/index.js";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  if (repo.pathExists(".claude/settings.json")) {
    if (!repo.fileContains(".claude/settings.json", "inject-tree-context")) {
      tasks.push(
        "Add SessionStart hook to `.claude/settings.json` (see `.context-tree/examples/claude-code/`)",
      );
    }
  } else if (!repo.anyAgentConfig()) {
    tasks.push(
      "No agent configuration detected. Configure your agent to load tree context at session start. See `.context-tree/examples/` for supported agents. You can skip this and set it up later.",
    );
  }
  return { group: "Agent Integration", order: 5, tasks };
}
