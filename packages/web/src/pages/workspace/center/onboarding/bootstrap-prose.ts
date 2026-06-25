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

export type TreeSetupBootstrapPlan = "createBinding" | "useBoundTree";

function formatSourceList(sourceUrls: readonly string[], heading: string): string[] {
  return [heading, ...sourceUrls.map((u) => `- ${u}`)];
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
  const sourceLines = sourceUrls.length > 0 ? ["", ...formatSourceList(sourceUrls, "Connected code:")] : [];
  const treeLine =
    opts.treeSetup === "pending"
      ? "A separate setup chat will prepare the team's shared memory, so keep this chat focused on the user's first useful task."
      : opts.treeSetup === "bound"
        ? "Team context is available; keep this chat focused on the user's first useful task."
        : "If the user shares code later, help them get value from it before asking about long-term team setup.";

  return [
    `First Tree is getting ${opts.agentDisplayName} ready to help with ${formatInlineScope(sourceUrls)}.`,
    "",
    "Use the first-tree-welcome skill for this onboarding first chat.",
    ...sourceLines,
    "",
    "Start with useful work: use the available code and team context to help the user choose a small first task.",
    treeLine,
  ].join("\n");
}

export function buildNoRepoBootstrap(agentDisplayName: string): string {
  return [
    `First Tree is introducing ${agentDisplayName} before code is connected.`,
    "",
    "Use the first-tree-welcome skill for this onboarding first chat.",
    "",
    "Help the user start by sharing a local folder path or a GitHub repo URL. Keep setup light and show value from real code first.",
  ].join("\n");
}

export function buildTreeSetupBootstrap(
  sourceUrls: readonly string[],
  opts: { treeBindingPlan: TreeSetupBootstrapPlan; treeUrl: string | null },
): string {
  const sourceLines = formatSourceList(sourceUrls, "Source code:");
  const treeLine = `Context Tree: ${opts.treeUrl ?? "resolved by First Tree Cloud"}`;
  return [
    "First Tree opened this separate setup chat to prepare the team's shared memory.",
    "",
    treeLine,
    "",
    ...sourceLines,
    "",
    "Use first-tree-read, first-tree-seed, or first-tree-write after reading the bound tree. Keep this chat focused on shared-memory setup; the user's first work chat is separate.",
  ].join("\n");
}

/**
 * Invitee joining a team that's already set up. The agent inherits the team's
 * recommended repos + Context Tree automatically, so the invitee never selects
 * repos or runs org setup. Keep the first chat value-first, not tree-authoring.
 */
export function buildInviteeReadyBootstrap(agentDisplayName: string, treeUrl: string): string {
  return [
    `First Tree is getting ${agentDisplayName} ready for this team.`,
    "",
    "Use the first-tree-welcome skill for this onboarding first chat.",
    "",
    `Team context: ${treeUrl}`,
    "",
    "Start with useful work: use the team's code and context to help the user choose a small first task.",
  ].join("\n");
}
