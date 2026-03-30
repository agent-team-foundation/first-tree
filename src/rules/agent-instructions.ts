import { FRAMEWORK_END_MARKER } from "#src/repo.js";
import type { Repo } from "#src/repo.js";
import type { RuleResult } from "#src/rules/index.js";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];
  if (!repo.pathExists("AGENT.md")) {
    tasks.push(
      "AGENT.md is missing — create from `.context-tree/templates/agent.md.template`",
    );
  } else if (!repo.hasAgentMdMarkers()) {
    tasks.push(
      "AGENT.md exists but is missing framework markers — add `<!-- BEGIN CONTEXT-TREE FRAMEWORK -->` and `<!-- END CONTEXT-TREE FRAMEWORK -->` sections",
    );
  } else {
    const text = repo.readFile("AGENT.md") ?? "";
    const afterMarker = text.split(FRAMEWORK_END_MARKER);
    if (afterMarker.length > 1) {
      const userSection = afterMarker[1].trim();
      const lines = userSection
        .split("\n")
        .filter(
          (l) =>
            l.trim() &&
            !l.trim().startsWith("#") &&
            !l.trim().startsWith("<!--"),
        );
      if (lines.length === 0) {
        tasks.push(
          "Add your project-specific instructions below the framework markers in AGENT.md",
        );
      }
    }
  }
  return { group: "Agent Instructions", order: 3, tasks };
}
