import type { Repo } from "../repo.js";
import type { RuleResult } from "./index.js";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  if (!repo.pathExists("members")) {
    tasks.push("`members/` directory is missing — create it with a NODE.md");
  } else if (!repo.pathExists("members/NODE.md")) {
    tasks.push("`members/NODE.md` is missing — create it from the template");
  }
  if (repo.hasMembers() && repo.memberCount() === 0) {
    tasks.push(
      "Add at least one member node for a team member or agent under `members/`",
    );
  } else if (!repo.hasMembers()) {
    tasks.push(
      "Add at least one member node for a team member or agent under `members/`",
    );
  }
  return { group: "Members", order: 4, tasks };
}
