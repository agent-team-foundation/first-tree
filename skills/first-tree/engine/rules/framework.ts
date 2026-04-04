import type { Repo } from "#skill/engine/repo.js";
import type { RuleResult } from "#skill/engine/rules/index.js";
import { installedSkillRootsDisplay } from "#skill/engine/runtime/asset-loader.js";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  if (!repo.hasFramework()) {
    tasks.push(
      `${installedSkillRootsDisplay()} not found — run \`context-tree init\` to install the framework skill bundled with the current \`first-tree\` package`,
    );
  }
  return { group: "Framework", order: 1, tasks };
}
