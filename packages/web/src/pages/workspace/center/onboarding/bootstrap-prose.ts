/**
 * Start-chat bootstrap prose for onboarding-created chats. Prose, not shell
 * recipes: the agent's workspace has the shipped First Tree skills
 * (`first-tree-welcome`, `first-tree-write`, `first-tree-read`,
 * `first-tree-seed`), and those skills own the concrete flow.
 *
 * Work/intro chats are value-first. Tree setup chats are separate and resilient:
 * Cloud owns creating/adopting the minimum tree repo binding, while the agent
 * reads the actual bound tree content and chooses seed vs read/write from that
 * evidence. A mere binding does not imply a populated tree.
 *
 * Single source of truth: only the start-chat step sends these. If a future surface
 * needs the same prompts, hoist these builders to `packages/shared`.
 */

export type TreeSetupBootstrapPlan = "createBinding" | "useBoundTree";

function formatSourceList(sourceUrls: readonly string[], heading: string): string[] {
  return [heading, ...sourceUrls.map((u) => `- ${u}`)];
}

export function buildValueFirstBootstrap(
  sourceUrls: readonly string[],
  opts: {
    agentDisplayName: string;
    treeSetup: "none" | "pending" | "bound";
  },
): string {
  const sourceLines = sourceUrls.length > 0 ? ["", ...formatSourceList(sourceUrls, "Connected code:")] : [];
  const treeLine =
    opts.treeSetup === "pending"
      ? "Operational note: use the first-tree-welcome skill for this onboarding first chat. Keep team context setup in the separate setup chat. For any new GitHub URL the user shares here, try host gh first before asking for First Tree GitHub App access."
      : opts.treeSetup === "bound"
        ? "Operational note: use the first-tree-welcome skill for this onboarding first chat. Use team context when helpful, but keep this chat focused on the first task. For any new GitHub URL the user shares here, try host gh first before asking for First Tree GitHub App access."
        : "Operational note: use the first-tree-welcome skill for this onboarding first chat. Keep setup light. If the user shares a GitHub URL, try host gh first before asking for First Tree GitHub App access.";

  return [
    `Welcome to your first First Tree chat with ${opts.agentDisplayName}.`,
    ...sourceLines,
    "",
    `${opts.agentDisplayName} will first get oriented from any available code and team context, then suggest a few small tasks you can start with.`,
    "",
    treeLine,
  ].join("\n");
}

export function buildNoRepoBootstrap(agentDisplayName: string): string {
  return [
    `Welcome to your first First Tree chat with ${agentDisplayName}.`,
    "",
    `Ask the user for the project they want help with, such as a path on their computer or a GitHub repo URL, then start from there.`,
    "",
    "Operational note: use the first-tree-welcome skill for this onboarding first chat. Keep setup light and show value from real code first. For GitHub URLs, use host gh/local credentials first. Ask for First Tree GitHub App access only when First Tree needs durable platform capabilities such as follow, webhook events, team repo resources, or Context Tree setup.",
  ].join("\n");
}

export function buildTreeSetupBootstrap(
  sourceUrls: readonly string[],
  opts: { treeBindingPlan: TreeSetupBootstrapPlan; treeUrl: string | null },
): string {
  const sourceLines = formatSourceList(sourceUrls, "Source code:");
  const treeLine = `Context Tree: ${opts.treeUrl ?? "resolved by First Tree Cloud"}`;
  return [
    "This chat sets up team context for future agent work.",
    "",
    treeLine,
    "",
    ...sourceLines,
    "",
    "This setup helps future agents understand the team's code, decisions, and conventions. The first task chat stays separate.",
    "",
    "Operational note: after reading the bound tree, use first-tree-read, first-tree-seed, or first-tree-write as appropriate.",
  ].join("\n");
}

/**
 * Invitee joining a team that's already set up. The agent inherits the team's
 * recommended repos + Context Tree automatically, so the invitee never selects
 * repos or runs org setup. Keep the first chat value-first, not tree-authoring.
 */
export function buildInviteeReadyBootstrap(agentDisplayName: string, treeUrl: string): string {
  return [
    `Welcome to your first First Tree chat with ${agentDisplayName}.`,
    "",
    `Team context: ${treeUrl}`,
    "",
    `${agentDisplayName} will use available team context to get oriented, then suggest a few small tasks the user can start with.`,
    "",
    "Operational note: use the first-tree-welcome skill for this onboarding first chat. Do not make team context setup the invitee's first task. If team setup is missing, explain that it is admin-owned and continue with a project path or host gh when possible.",
  ].join("\n");
}
