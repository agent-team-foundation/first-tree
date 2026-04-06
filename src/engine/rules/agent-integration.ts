import type { Repo } from "#skill/engine/repo.js";
import type { RuleResult } from "#skill/engine/rules/index.js";
import { claudeCodeExampleCandidates } from "#skill/engine/runtime/adapters.js";
import { FRAMEWORK_EXAMPLES_DIR } from "#skill/engine/runtime/asset-loader.js";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  const [claudeExamplePath] = claudeCodeExampleCandidates();
  if (repo.pathExists(".claude/settings.json")) {
    if (!repo.fileContains(".claude/settings.json", "inject-tree-context")) {
      tasks.push(
        `Add SessionStart hook to \`.claude/settings.json\` (see \`${claudeExamplePath}/\`)`,
      );
    }
  } else if (!repo.anyAgentConfig()) {
    tasks.push(
      `No agent configuration detected. Configure your agent to load tree context at session start. See \`${FRAMEWORK_EXAMPLES_DIR}/\` for supported agents. You can skip this and set it up later.`,
    );
  }
  return { group: "Agent Integration", order: 5, tasks };
}
