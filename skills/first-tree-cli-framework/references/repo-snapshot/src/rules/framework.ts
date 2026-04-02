import type { Repo } from "#src/repo.js";
import type { RuleResult } from "#src/rules/index.js";

const SEED_TREE_URL = "https://github.com/agent-team-foundation/seed-tree";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  if (!repo.hasFramework()) {
    tasks.push(
      `\`.context-tree/\` not found — run \`context-tree init\` to clone the framework from ${SEED_TREE_URL}`,
    );
  }
  return { group: "Framework", order: 1, tasks };
}
