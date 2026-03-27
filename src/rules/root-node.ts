import type { Repo } from "../repo.js";
import type { RuleResult } from "./index.js";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  if (!repo.pathExists("NODE.md")) {
    tasks.push(
      "NODE.md is missing — create from `.context-tree/templates/root-node.md.template`, fill in your project's domains",
    );
  } else {
    const fm = repo.frontmatter("NODE.md");
    if (fm === null) {
      tasks.push(
        "NODE.md exists but has no frontmatter — add frontmatter with title and owners fields",
      );
    } else {
      if (!fm.title || fm.title.startsWith("<")) {
        tasks.push(
          "NODE.md has a placeholder title — replace with your organization name",
        );
      }
      if (
        !fm.owners ||
        fm.owners.length === 0 ||
        (fm.owners.length === 1 && fm.owners[0].startsWith("<"))
      ) {
        tasks.push(
          "NODE.md has placeholder owners — set owners to your GitHub username(s)",
        );
      }
    }
    if (repo.hasPlaceholderNode()) {
      tasks.push(
        "NODE.md has placeholder content — fill in your project's domains and description",
      );
    }
  }
  return { group: "Root Node", order: 2, tasks };
}
