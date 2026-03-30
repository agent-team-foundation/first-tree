import type { Repo } from "#src/repo.js";
import type { RuleResult } from "#src/rules/index.js";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  if (!repo.pathExists("NODE.md")) {
    tasks.push(
      "NODE.md is missing — create from `.context-tree/templates/root-node.md.template`. " +
      "Ask the user for their code repositories or project directories, then analyze the source to determine the project description and domain structure",
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
        "NODE.md has placeholder content — ask the user for their code repositories or project directories, then analyze the source to fill in the project description and domain structure",
      );
    }
  }
  return { group: "Root Node", order: 2, tasks };
}
