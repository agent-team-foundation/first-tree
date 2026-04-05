import type { Repo } from "#skill/engine/repo.js";
import type { RuleResult } from "#skill/engine/rules/index.js";
import { INTERACTIVE_TOOL } from "#skill/engine/init.js";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];

  tasks.push(
    `Ask the user whether they want to populate the full context tree now using the **${INTERACTIVE_TOOL}** tool. ` +
      "Present two options: (1) **Yes — populate the full tree**: the agent will analyze source repositories, " +
      "create sub-domains, and populate NODE.md files for each domain and sub-domain; " +
      "(2) **No — I'll do it later**: skip deep population and finish init with just the top-level structure. " +
      "If the user selects No, check off all remaining items in this section and move on.",
  );

  tasks.push(
    "If the user selected Yes: analyze the codebase (and any additional repositories the user provides) to identify " +
      "logical sub-domains within each top-level domain. For each sub-domain, create a directory with a NODE.md " +
      "containing proper frontmatter (title, owners) and a description of the sub-domain's purpose, boundaries, " +
      "and key decisions. Create deeper sub-domains when a domain is large enough to warrant further decomposition.",
  );

  tasks.push(
    "Use **sub-tasks** (TaskCreate) to parallelize the population work — create one sub-task per top-level domain " +
      "so each domain can be populated concurrently. Each sub-task should: read the relevant source code, identify " +
      "sub-domains, create NODE.md files, and establish soft_links between related domains.",
  );

  tasks.push(
    "After all domains are populated, update the root NODE.md to list every top-level domain with a one-line " +
      "description. Ensure all NODE.md files pass `first-tree verify` — valid frontmatter, no placeholders, " +
      "and soft_links that resolve correctly.",
  );

  return { group: "Populate Tree", order: 7, tasks };
}
