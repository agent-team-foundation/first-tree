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
 *   - new tree (buildCreateBootstrap): today, the Cloud-side `runKickoff` path
 *     does NOT provision the tree repo, write the org's `context_tree`
 *     setting, or bind the workspace before sending the kickoff message
 *     (`step-kickoff.tsx` passes `contextTreeUrl: null`). The message
 *     therefore must NOT name `$first-tree-seed`: that skill's self-check
 *     hard-requires those preconditions and would refuse on every new-tree
 *     onboarding. Instead, the prose states the user's goal in plain
 *     language; the agent uses its full skill set (`first-tree-context` for
 *     writes, plus general tooling) to bind + host + record + draft. When
 *     Cloud gains a real provisioning step (creates the tree repo, writes
 *     `context_tree`, writes `workspace.json`) BEFORE sending kickoff, a
 *     future PR will switch this prose to name `$first-tree-seed` and drop
 *     the bind/host/record-URL instructions. See PR 899 (baixiaohang's r3 review).
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
    ? "Set up First Tree for my source repo and create a brand-new Context Tree for it."
    : "Set up First Tree for my source repos and create one shared Context Tree they all bind to.";
  const goalLine = single
    ? "Bind the repo to the new Context Tree, and — this part matters most — draft real starting content for the tree from what's actually in the repo, not placeholders. Host the new tree as its own GitHub repo under the same owner as the source."
    : "Bind every repo to the one new shared Context Tree, and — this part matters most — draft real starting content for the tree from what's actually in the repos, not placeholders. Host the new tree as its own GitHub repo under the owner the sources share (ask me which owner if they don't share one).";
  const walkthrough = single
    ? "Show me the diffs before anything is pushed, and walk me through what got created — the tree repo, its content, and the PR."
    : "Show me the diffs before anything is pushed, and walk me through what got created — the tree repo, its content, and each PR.";
  return [
    opener,
    "",
    ...sourceLines,
    "",
    goalLine,
    "",
    "Once the tree repo is up on GitHub, record its URL in First Tree with the First Tree CLI so future teammates' agents can find it.",
    "",
    walkthrough,
    "",
    `Reference: ${FIRST_TREE_REFERENCE_URL}`,
  ].join("\n");
}
