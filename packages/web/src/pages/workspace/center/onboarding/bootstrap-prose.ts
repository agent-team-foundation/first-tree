/**
 * The two kickoff bootstrap messages the onboarding "Your Context Tree" step
 * sends to a freshly-created agent, chosen by the user's "new vs existing tree"
 * choice. Prose, not shell recipes: the agent's workspace has the shipped
 * First Tree skills (`first-tree`, `first-tree-context`, `first-tree-sync`,
 * `first-tree-seed`), and those skills own the concrete flow. These messages
 * only state the goal + the source repos (and, for the existing path, the
 * tree URL) and defer the mechanics, so they don't drift as the CLI / skills
 * evolve.
 *
 * Two paths:
 *   - existing tree (buildBindBootstrap): the frontend has already best-effort
 *     PUT the URL into the org's `context_tree` settings before sending, so the
 *     message doesn't ask the agent to record it in First Tree again. The
 *     tree is already populated, so `first-tree-seed` does not apply — the
 *     agent uses `first-tree-context` for any further writes.
 *   - new tree (buildCreateBootstrap): Cloud creates the brand-new empty tree
 *     repo on GitHub, records its URL in the org's `context_tree` settings,
 *     and binds the workspace to it BEFORE this kickoff is sent. The message
 *     therefore only names `$first-tree-seed` — the one-shot bootstrap for
 *     filling a pre-provisioned empty tree — and does not ask the agent to
 *     bind, host, or record the tree URL. `first-tree-seed`'s self-check
 *     refuses if any of those preconditions are missing.
 *
 * Single source of truth: only the kickoff step sends these. If a future surface
 * needs the same prompts, hoist these builders to `packages/shared`.
 */

export const FIRST_TREE_REFERENCE_URL = "https://github.com/agent-team-foundation/first-tree";

function formatSourceList(sourceUrls: readonly string[]): string[] {
  if (sourceUrls.length === 1) {
    return [`Source repo: ${sourceUrls[0]}`];
  }
  return ["Source repos:", ...sourceUrls.map((u) => `- ${u}`)];
}

export function buildBindBootstrap(sourceUrls: readonly string[], treeUrl: string): string {
  const sourceLines = formatSourceList(sourceUrls);
  const single = sourceUrls.length === 1;
  const opener = single
    ? "Set up First Tree for my source repo, binding it to our team's existing Context Tree."
    : "Set up First Tree for my source repos, binding them to our team's existing Context Tree.";
  const skillLine = single
    ? "Use your First Tree skills to bind the repo to that existing tree, then open a PR back to the source with the binding. Show me the diff before it's pushed, and walk me through the PR."
    : "Use your First Tree skills to bind every repo to that existing tree, then open a PR back to each source with its binding. Show me the diffs before they're pushed, and walk me through each PR.";
  return [
    opener,
    "",
    ...sourceLines,
    `Existing tree: ${treeUrl}`,
    "",
    skillLine,
    "",
    `Reference: ${FIRST_TREE_REFERENCE_URL}`,
  ].join("\n");
}

export function buildCreateBootstrap(sourceUrls: readonly string[]): string {
  const sourceLines = formatSourceList(sourceUrls);
  const single = sourceUrls.length === 1;
  const opener = single
    ? "Seed the brand-new Context Tree we've just provisioned for my source repo."
    : "Seed the one shared Context Tree we've just provisioned for my source repos.";
  const skillLine = single
    ? "Run $first-tree-seed end to end: draft real starting content for the tree from what's actually in the repo, not placeholders. The tree repo and workspace binding are already in place — your job is to fill the empty tree."
    : "Run $first-tree-seed end to end: draft real starting content for the tree from what's actually in the repos, not placeholders. The tree repo and workspace binding are already in place — your job is to fill the empty tree.";
  const walkthrough = single
    ? "Show me the diff before each PR is pushed, and walk me through both — PR1 for the top-level structure, PR2 for the leaf content."
    : "Show me the diffs before each PR is pushed, and walk me through both — PR1 for the top-level structure, PR2 for the leaf content across every domain.";
  return [
    opener,
    "",
    ...sourceLines,
    "",
    skillLine,
    "",
    walkthrough,
    "",
    `Reference: ${FIRST_TREE_REFERENCE_URL}`,
  ].join("\n");
}
