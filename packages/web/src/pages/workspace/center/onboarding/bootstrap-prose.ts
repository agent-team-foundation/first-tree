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

export type TreeSetupBootstrapPlan = "agentSeed" | "createBinding" | "useBoundTree";

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

  return [
    `${opts.agentDisplayName}, welcome aboard.`,
    "",
    "Please help me get started with First Tree.",
    ...sourceLines,
  ].join("\n");
}

export function buildNoRepoBootstrap(agentDisplayName: string): string {
  return [`${agentDisplayName}, welcome aboard.`, "", "Please help me get started with First Tree."].join("\n");
}

export function buildTreeSetupBootstrap(
  sourceUrls: readonly string[],
  opts: { treeBindingPlan: TreeSetupBootstrapPlan; treeUrl: string | null },
): string {
  const sourceLines = formatSourceList(sourceUrls, "Source code:");
  if (opts.treeBindingPlan === "agentSeed") {
    // No binding yet — the agent builds the Context Tree from zero in this
    // tree-less chat. Visible task text only, per the onboarding kickoff
    // contract: name no skill; the agent recognizes the build task and reaches
    // `first-tree-seed` from its skill map. Do not reference a bound tree.
    return [
      "Build our team's Context Tree from our connected code: create the repo, propose an initial structure for me to review, then fill it in.",
      "",
      ...sourceLines,
      "",
      "This gives future agents the team's code, decisions, and conventions. The first task chat stays separate.",
    ].join("\n");
  }
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
    "Read the bound tree first. Use first-tree-read, first-tree-seed, or first-tree-write as appropriate.",
  ].join("\n");
}

/**
 * Invitee joining a team that's already set up. The agent inherits the team's
 * recommended repos + Context Tree automatically, so the invitee never selects
 * repos or runs org setup. Keep the first chat value-first, not tree-authoring.
 */
export function buildInviteeReadyBootstrap(agentDisplayName: string): string {
  return [`${agentDisplayName}, welcome aboard.`, "", "Please help me get settled into this team on First Tree."].join(
    "\n",
  );
}
