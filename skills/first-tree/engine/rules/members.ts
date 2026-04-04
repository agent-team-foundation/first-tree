import type { Repo } from "#skill/engine/repo.js";
import type { RuleResult } from "#skill/engine/rules/index.js";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  if (!repo.pathExists("members")) {
    tasks.push("`members/` directory is missing — create it with a NODE.md");
  } else if (!repo.pathExists("members/NODE.md")) {
    tasks.push("`members/NODE.md` is missing — create it from the template");
  }
  if (repo.hasMembers() && repo.memberCount() === 0) {
    tasks.push(
      "Add at least one member node under `members/`. Analyze the user's code repositories (git history, CODEOWNERS, README contributors) to suggest members, then confirm with the user",
    );
  } else if (!repo.hasMembers()) {
    tasks.push(
      "Add at least one member node under `members/`. Analyze the user's code repositories (git history, CODEOWNERS, README contributors) to suggest members, then confirm with the user",
    );
  }
  return { group: "Members", order: 4, tasks };
}
