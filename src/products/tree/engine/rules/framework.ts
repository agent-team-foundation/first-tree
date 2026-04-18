import type { Repo } from "#products/tree/engine/repo.js";
import type { RuleResult } from "#products/tree/engine/rules/index.js";
import {
  FIRST_TREE_INDEX_FILE,
  installedSkillRootsDisplay,
} from "#products/tree/engine/runtime/asset-loader.js";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  if (!repo.hasFramework()) {
    tasks.push(
      `Framework metadata not found — run \`first-tree tree init\` to install ${installedSkillRootsDisplay()} plus \`${FIRST_TREE_INDEX_FILE}\` in a source/workspace repo, or bootstrap a dedicated tree repo with \`.first-tree/\` metadata`,
    );
  }
  return { group: "Framework", order: 1, tasks };
}
