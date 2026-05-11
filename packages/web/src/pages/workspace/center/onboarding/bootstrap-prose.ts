/**
 * Two bootstrap-message variants Step 3 IntroBody dispatches based on the
 * user's "do you already have a tree?" choice. Prose, not shell recipes —
 * the agent has the first-tree skill (and the source repos, materialised
 * via `gitRepos`) ready in its workspace, so the message just describes
 * the goal and references the CLI surfaces by name. The skill knows the
 * concrete commands.
 *
 * Path A (existing tree) skips Hub bookkeeping at the end — the web
 * frontend best-effort PUTs the URL into the org's `context_tree`
 * settings namespace before sending the chat (non-fatal — agent still
 * proceeds if the PUT fails). Path B (new tree) tells the agent to call
 * back into the first-tree-hub CLI to record the freshly created URL.
 *
 * Single source of truth: only Step 3 IntroBody currently sends these.
 * If a future surface needs the same prompts, hoist these builders to
 * `packages/shared` so both import the same strings.
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
  const opener =
    sourceUrls.length === 1
      ? "Bind my source repo to an existing context-tree."
      : "Bind my source repos to an existing context-tree.";
  const skillLine =
    sourceUrls.length === 1
      ? "Your workspace already has the source repo cloned in a subdirectory; the first-tree skill will locate it. Use the first-tree CLI to install the skill in the source repo and write the binding metadata pointing at the existing tree, then open a PR back to the source with those changes. Walk me through the PR when it's up."
      : "Your workspace already has each source repo cloned in its own subdirectory; the first-tree skill will locate them. For every source repo, use the first-tree CLI to install the skill and write the binding metadata pointing at the existing tree, then open a PR back to that source repo. Walk me through each PR as it goes up.";
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
  const opener =
    sourceUrls.length === 1
      ? "Create a brand-new context-tree for my source repo."
      : "Create a brand-new context-tree for my source repos.";
  const skillLine =
    sourceUrls.length === 1
      ? "Your workspace already has the source repo cloned in a subdirectory; the first-tree skill will locate it. Use the first-tree CLI to install the skill in the source, scaffold a sibling tree directory, and write the binding metadata. Then push that new tree directory up to GitHub as a sibling repo under the same owner as the source, and open a PR back to the source with the skill + binding files."
      : "Your workspace already has each source repo cloned in its own subdirectory; the first-tree skill will locate them. Scaffold ONE shared tree directory that all the source repos bind to. For every source repo, install the first-tree skill and write the binding metadata pointing at that shared tree. Push the new tree directory up to GitHub as its own repo — if all the source repos share a single GitHub owner, host the tree under that owner; otherwise ask me which owner to use before pushing. Then open a PR back to each source repo with its skill + binding files.";
  return [
    opener,
    "",
    ...sourceLines,
    "",
    skillLine,
    "",
    "Once you know the URL of the new tree repo, use the first-tree-hub CLI's `org bind-tree` command to record it on the Hub so future agents in this team can find it.",
    "",
    "When everything is up, walk me through what was created — which directory, which repo, which PRs.",
    "",
    `Reference: ${FIRST_TREE_REFERENCE_URL}`,
  ].join("\n");
}
