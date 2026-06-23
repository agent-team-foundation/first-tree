/**
 * Kickoff bootstrap prose for onboarding-created chats. Prose, not shell
 * recipes: the agent's workspace has the shipped First Tree skills
 * (`first-tree-welcome`, `first-tree-write`, `first-tree-read`,
 * `first-tree-seed`), and those skills own the concrete flow.
 *
 * Work/intro chats are value-first. Tree setup chats are separate and resilient:
 * Cloud owns creating/adopting the minimum tree repo binding, while the agent
 * reads the actual bound tree content and chooses seed vs read/write from that
 * evidence. A mere binding does not imply a populated tree.
 *
 * Single source of truth: only the kickoff step sends these. If a future surface
 * needs the same prompts, hoist these builders to `packages/shared`.
 */

export const FIRST_TREE_REFERENCE_URL = "https://github.com/agent-team-foundation/first-tree";

export type TreeSetupBootstrapPlan = "createBinding" | "useBoundTree";

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
    treeSetup: "none" | "pending" | "bound";
  },
): string {
  const sourceLines = sourceUrls.length > 0 ? ["", ...formatSourceList(sourceUrls)] : [];
  const treeLine =
    opts.treeSetup === "pending"
      ? "A separate Context Tree setup chat will handle the heavier shared-memory bootstrap; mention it lightly, but do not make tree setup the user's first task."
      : opts.treeSetup === "bound"
        ? "A separate Context Tree setup chat may refresh the team's shared memory; keep this chat focused on helping the user get useful work done."
        : "If the user later points you at a repo, help them get immediate value before asking for any long-term team setup.";

  return [
    `First Tree is getting ${opts.agentDisplayName} up to speed on ${formatInlineScope(sourceUrls)}.`,
    "",
    "Use the first-tree-welcome skill for this onboarding first chat.",
    "",
    "Goal: read before speaking, show concrete understanding, then help the user complete one useful first task.",
    ...sourceLines,
    "",
    "First response requirements:",
    "- Cite specific evidence from the repo or team context: stack, entry points, modules, tests, TODOs, conventions, or a concrete risk you actually observed.",
    "- Offer 2–3 evidence-backed first tasks that are small, low-risk, verifiable, and likely to produce user-visible value quickly.",
    "- Send the task menu as format=request with concise real-task options and free-text accepted; do not add a separate skip option because the Web ask footer already provides Skip.",
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
    "Use the first-tree-welcome skill for this onboarding first chat.",
    "",
    "Goal: be useful immediately, then invite the user to point you at real code without requiring GitHub authorization first.",
    "",
    "First response requirements:",
    "- Introduce yourself briefly as the user's agent.",
    "- Ask for either a local clone path or a GitHub URL so you can read the code on this machine.",
    "- Make clear that reading a local clone or accessible URL can happen before any long-term team setup.",
    "- If the user gives code, inspect it and then send a format=request menu with 2–3 evidence-backed, bounded first tasks and free-text accepted; do not add a separate skip option because the Web ask footer already provides Skip.",
    "- Only after showing value should you ask whether the repo should become long-term team code.",
    "- Do not ask for broad GitHub authorization before the user has seen repo-specific value.",
    "",
    `Reference: ${FIRST_TREE_REFERENCE_URL}`,
  ].join("\n");
}

export function buildTreeSetupBootstrap(
  sourceUrls: readonly string[],
  opts: { treeBindingPlan: TreeSetupBootstrapPlan; treeUrl: string | null },
): string {
  const sourceLines = formatSourceList(sourceUrls);
  const bindingLine = opts.treeUrl
    ? `Bound Context Tree: ${opts.treeUrl}`
    : "Bound Context Tree: resolved by First Tree Cloud";
  const setupLine =
    opts.treeBindingPlan === "createBinding"
      ? "First Tree Cloud has created or adopted the team's Context Tree repo and recorded the org binding for this setup lane."
      : "First Tree Cloud found an existing org Context Tree binding for this setup lane.";
  return [
    "First Tree has connected the selected source repos and opened this separate Context Tree setup chat.",
    "",
    ...sourceLines,
    bindingLine,
    "",
    setupLine,
    "",
    "Read the bound Context Tree first, starting at root NODE.md.",
    "If the tree is still empty or only contains the Cloud bootstrap placeholder, use the first-tree-seed skill to draft the initial tree from the bound source repos.",
    "If the tree already has real structure or content, use first-tree-read to orient and first-tree-write only for warranted incremental updates from the connected repos.",
    "Show the user the diff and walk through any PR before pushing.",
    "This tree chat owns shared-memory setup/update; do not turn it into the user's first value task.",
    "",
    "Do not impersonate the user or say the user asked for this. First Tree sent this system kickoff.",
    "",
    `Reference: ${FIRST_TREE_REFERENCE_URL}`,
  ].join("\n");
}

/**
 * Invitee joining a team that's already set up. The agent inherits the team's
 * recommended repos + Context Tree automatically, so the invitee never selects
 * repos or runs org setup. Keep the first chat value-first, not tree-authoring.
 */
export function buildInviteeReadyBootstrap(agentDisplayName: string, treeUrl: string): string {
  return [
    `First Tree is welcoming ${agentDisplayName} for a teammate joining a team that already has code access and a shared Context Tree.`,
    "",
    "Use the first-tree-welcome skill for this onboarding first chat.",
    "",
    `Team Context Tree: ${treeUrl}`,
    "",
    "First response requirements:",
    "- Read the team's Context Tree first, starting at root NODE.md, and use inherited recommended repos where available.",
    "- Cite concrete evidence from the tree, repos, or both; do not promise access to private repos the member's local credentials cannot reach.",
    "- Briefly introduce what you can help with as this teammate's agent.",
    "- Offer 2–3 evidence-backed first tasks that are small, low-risk, verifiable, and likely to produce user-visible value quickly.",
    "- Send the task menu as format=request with concise real-task options and free-text accepted; do not add a separate skip option because the Web ask footer already provides Skip.",
    "- Do not make writing or seeding the Context Tree the invitee's first task.",
    "- Do not impersonate the user or say the user asked for this. First Tree sent this system kickoff.",
    "",
    `Reference: ${FIRST_TREE_REFERENCE_URL}`,
  ].join("\n");
}
