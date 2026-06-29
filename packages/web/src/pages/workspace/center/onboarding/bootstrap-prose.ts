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
  const sourceLines =
    sourceUrls.length > 0 ? ["", ...formatSourceList(sourceUrls, "It's already connected to your code:")] : [];
  const teamContextLines =
    opts.treeSetup === "bound"
      ? ["", `${opts.agentDisplayName} can also draw on your team's shared context to get up to speed faster.`]
      : [];

  return [
    `Welcome to First Tree — this is your first chat with ${opts.agentDisplayName}.`,
    ...sourceLines,
    "",
    `${opts.agentDisplayName} will get oriented and then suggest a few small tasks you could start with — or just tell it what you have in mind.`,
    ...teamContextLines,
  ].join("\n");
}

export function buildNoRepoBootstrap(agentDisplayName: string): string {
  return [
    `Welcome to First Tree — this is your first chat with ${agentDisplayName}.`,
    "",
    `Tell ${agentDisplayName} what you'd like to work on: point it at a folder on your computer or paste a GitHub URL, and it'll take a look and suggest a few things you could start with.`,
    "",
    `No GitHub connection needed to begin — ${agentDisplayName} works right from your machine. You can connect First Tree to GitHub later, only if a task needs it.`,
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
export function buildInviteeReadyBootstrap(agentDisplayName: string): string {
  return [
    `Welcome to First Tree — this is your first chat with ${agentDisplayName}.`,
    "",
    `Your team's shared context is already set up, so ${agentDisplayName} can get oriented from the team's work and suggest a few things to start with. Tell it what you'd like to dig into.`,
  ].join("\n");
}
