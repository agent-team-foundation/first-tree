/**
 * The two kickoff bootstrap messages the onboarding "Your Context Tree" step
 * sends to a freshly-created agent, chosen by the user's "new vs existing tree"
 * choice. Prose, not shell recipes: the agent's workspace has the shipped
 * First Tree skills (`first-tree-guide`, `first-tree-write`, `first-tree-read`,
 * `first-tree-seed`), and those skills own the concrete flow. These messages
 * only state the goal + the source repos (and, for the existing path, the
 * tree URL) and defer the mechanics, so they don't drift as the CLI / skills
 * evolve.
 *
 * Both paths now assume Cloud has provisioned + bound the tree BEFORE the
 * kickoff message is sent: `runKickoff` creates the tree repo + writes the
 * org's `context_tree` setting (new-tree, via the initializer), and the
 * runtime writes `<workspace>/.first-tree/workspace.json` once the agent's
 * session resolves the binding. That precondition is what lets the prose name
 * skills directly instead of asking the agent to self-provision.
 *
 * Three paths:
 *   - existing tree (buildBindBootstrap): the team's tree already exists and is
 *     populated, and the binding (workspace.json) is written automatically by
 *     the runtime — so the agent is NOT asked to bind or open a PR back to the
 *     source. `first-tree-seed` does not apply to a populated tree; the agent
 *     reads the tree and uses `first-tree-write` for any further writes. Sent
 *     for the admin who just connected repos to an already-existing team tree.
 *   - new tree (buildCreateBootstrap): Cloud has already created the empty tree
 *     repo, written `context_tree`, and (on this session) the runtime writes
 *     `workspace.json`, so the new-tree self-check preconditions for
 *     `first-tree-seed` hold. The prose names `first-tree-seed` directly and
 *     asks the agent to seed the already-bound, still-empty tree with real
 *     content drawn from the source repos — it no longer asks the agent to
 *     create the GitHub repo or record its URL (Cloud owns both).
 *   - invitee joining a set-up team (buildInviteeBootstrap): the team's tree and
 *     repos already exist and the agent inherits them automatically (recommended
 *     team resources), so the invitee never connected anything. The prose is in a
 *     joining-teammate voice — get oriented by reading the tree, then introduce
 *     yourself — NOT the admin's "my repos are now connected, reflect them into
 *     the tree" (a brand-new teammate shouldn't open with tree writes).
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

function formatInlineScope(sourceUrls: readonly string[]): string {
  if (sourceUrls.length === 0) return "your team's connected repos";
  if (sourceUrls.length === 1) return sourceUrls[0] ?? "the connected repo";
  return `${sourceUrls.length} connected repos`;
}

export function buildValueFirstBootstrap(
  sourceUrls: readonly string[],
  opts: {
    agentDisplayName: string;
    contextTreeMode: "none" | "new" | "existing";
  },
): string {
  const sourceLines = sourceUrls.length > 0 ? ["", ...formatSourceList(sourceUrls)] : [];
  const treeLine =
    opts.contextTreeMode === "new"
      ? "A separate Context Tree setup chat will handle the heavier shared-memory bootstrap; mention it lightly, but do not make tree setup the user's first task."
      : opts.contextTreeMode === "existing"
        ? "A separate Context Tree setup chat may refresh the team's shared memory; keep this chat focused on helping the user get useful work done."
        : "If the user later points you at a repo, help them get immediate value before asking for any long-term team setup.";

  return [
    `First Tree is getting ${opts.agentDisplayName} up to speed on ${formatInlineScope(sourceUrls)}.`,
    "",
    "Use the first-tree-guide skill for this onboarding first chat.",
    "",
    "Goal: read before speaking, show concrete understanding, then help the user complete one useful first task.",
    ...sourceLines,
    "",
    "First response requirements:",
    "- Cite specific evidence from the repo or team context: stack, entry points, modules, tests, TODOs, conventions, or a concrete risk you actually observed.",
    "- Offer 2–3 evidence-backed first tasks that are small, low-risk, verifiable, and likely to produce user-visible value quickly.",
    "- Send the task menu as format=request with concise options, a `Skip for now` option, and free-text accepted.",
    "- If evidence is thin, prefer read-only orientation tasks such as mapping the architecture or explaining the test strategy; do not invent bugs.",
    `- ${treeLine}`,
    "- Do not impersonate the user or say the user asked for this. First Tree sent this system kickoff.",
    "",
    `Reference: ${FIRST_TREE_REFERENCE_URL}`,
  ].join("\n");
}

export function buildNoRepoBootstrap(agentDisplayName: string): string {
  return [
    `First Tree is introducing ${agentDisplayName} before a repo is connected.`,
    "",
    "Use the first-tree-guide skill for this onboarding first chat.",
    "",
    "Goal: be useful immediately, then invite the user to point you at real code without requiring GitHub authorization first.",
    "",
    "First response requirements:",
    "- Introduce yourself briefly as the user's agent.",
    "- Ask for either a local clone path or a GitHub URL so you can read the code on this machine.",
    "- Make clear that reading a local clone or accessible URL can happen before any long-term team setup.",
    "- If the user gives code, inspect it and then send a format=request menu with 2–3 evidence-backed, bounded first tasks plus `Skip for now`.",
    "- Only after showing value should you ask whether the repo should become long-term team code.",
    "- Do not ask for broad GitHub authorization before the user has seen repo-specific value.",
    "",
    `Reference: ${FIRST_TREE_REFERENCE_URL}`,
  ].join("\n");
}

export function buildBindBootstrap(sourceUrls: readonly string[], treeUrl: string): string {
  const sourceLines = formatSourceList(sourceUrls);
  const single = sourceUrls.length === 1;
  const opener = single
    ? "My source repo is now connected to our team's existing Context Tree."
    : "My source repos are now connected to our team's existing Context Tree.";
  const skillLine = single
    ? "Read the tree first to get oriented — start at its root NODE.md. If this repo introduces decisions, ownership, or context worth recording, use the first-tree-write skill to reflect them into the tree — show me the diff and walk me through any PR before it's pushed."
    : "Read the tree first to get oriented — start at its root NODE.md. If these repos introduce decisions, ownership, or context worth recording, use the first-tree-write skill to reflect them into the tree — show me the diffs and walk me through any PRs before they're pushed.";
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
    ? "My team's Context Tree is set up and bound to my source repo — now seed it with real starting content."
    : "My team's Context Tree is set up and bound to my source repos — now seed it with real starting content.";
  const skillLine = single
    ? "Use the first-tree-seed skill: read the bound source repo, then draft the tree's initial structure and starting content from what's actually in it — not placeholders."
    : "Use the first-tree-seed skill: read every bound source repo, then draft the tree's initial structure and starting content from what's actually in them — not placeholders.";
  const walkthrough = single
    ? "Show me the diff before anything is pushed, and walk me through each PR as it opens."
    : "Show me the diffs before anything is pushed, and walk me through each PR as it opens.";
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

/**
 * Invitee joining a team that's already set up. The agent already inherits the
 * team's repos + Context Tree (recommended team resources + the runtime's
 * workspace.json), so the invitee never connected anything and is NOT asked to
 * reflect decisions into the tree on its first message. Instead: read the tree
 * to get oriented, then introduce yourself — the right tone for a brand-new
 * teammate's first hello.
 */
export function buildInviteeBootstrap(treeUrl: string): string {
  return [
    "I've just joined the team and you're my agent. The team already has its repos connected and a shared Context Tree.",
    "",
    `Team Context Tree: ${treeUrl}`,
    "",
    "Read the tree first to get oriented — start at its root NODE.md — so you understand how the team works and what it's building. Then introduce yourself to me: what can you help with, and what's a good first thing for us to try?",
    "",
    `Reference: ${FIRST_TREE_REFERENCE_URL}`,
  ].join("\n");
}
