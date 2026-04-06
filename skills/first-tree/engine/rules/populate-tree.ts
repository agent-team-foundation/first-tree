import type { Repo } from "#skill/engine/repo.js";
import type { RuleResult } from "#skill/engine/rules/index.js";
import { INTERACTIVE_TOOL } from "#skill/engine/init.js";

export function evaluate(repo: Repo): RuleResult {
  const tasks: string[] = [];

  tasks.push(
    "Read `progress.md` (normally `.first-tree/progress.md` in a dedicated tree repo) as the source of truth for the onboarding checkpoint before you ask about deeper tree population. " +
      "Tell the user what is already done and what remains, and split the report into at least two lanes: " +
      "(1) setup / source-workspace integration progress and (2) tree-content baseline coverage progress. " +
      "Highlight the remaining work categories, and prefer phrases like `baseline coverage` or `first pass` instead of claiming the tree is fully complete.",
  );

  tasks.push(
    `Ask the user whether they want to continue building the first-pass full tree now using the **${INTERACTIVE_TOOL}** tool. ` +
      "Present two options: (1) **Yes — continue baseline tree expansion**: explain the expected scope first, " +
      "including how many top-level domains you plan to cover, how many waves of parallel work you expect, " +
      "and that you will finish with root-node reconciliation plus `first-tree verify`; " +
      "(2) **No — keep the initial scaffold only**: skip deep population and finish init with the current top-level structure. " +
      "If the user selects No, check off all remaining items in this section and move on.",
  );

  tasks.push(
    "If the user selected Yes: analyze the codebase (and any additional repositories the user provides) to identify " +
      "logical sub-domains within each top-level domain. For each sub-domain, create a directory with a NODE.md " +
      "containing proper frontmatter (title, owners) and a description of the sub-domain's purpose, boundaries, " +
      "and key decisions. Create deeper sub-domains when a domain is large enough to warrant further decomposition.",
  );

  tasks.push(
    "Use parallel **sub-tasks / subagents** (for example, TaskCreate where available) in waves, not as unbounded fan-out. " +
      "The default split is one sub-task per top-level domain so each domain can be populated concurrently. " +
      "Keep the main agent responsible for the root `NODE.md`, cross-domain `soft_links`, overlap cleanup between domains, " +
      "and the final `first-tree verify` pass. Each domain sub-task should: read the relevant source code, identify " +
      "sub-domains, create NODE.md files, and establish soft_links between related domains.",
  );

  tasks.push(
    "Continue launching additional waves until every top-level domain has first-pass baseline coverage. " +
      "After the domain waves finish, update the root NODE.md to list every top-level domain with a one-line " +
      "description, reconcile any cross-domain soft_links, and ensure all NODE.md files pass `first-tree verify` — valid frontmatter, no placeholders, " +
      "and soft_links that resolve correctly.",
  );

  return { group: "Populate Tree", order: 7, tasks };
}
