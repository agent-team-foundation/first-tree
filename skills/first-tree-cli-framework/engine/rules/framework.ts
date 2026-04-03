import type { Repo } from "#skill/engine/repo.js";
import type { RuleResult } from "#skill/engine/rules/index.js";
import { SKILL_ROOT } from "#skill/engine/runtime/asset-loader.js";

const FIRST_TREE_REPO_URL = "https://github.com/agent-team-foundation/first-tree";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  if (!repo.hasFramework()) {
    tasks.push(
      `\`${SKILL_ROOT}/\` not found — run \`context-tree init\` to install the framework skill from ${FIRST_TREE_REPO_URL}`,
    );
  }
  return { group: "Framework", order: 1, tasks };
}
