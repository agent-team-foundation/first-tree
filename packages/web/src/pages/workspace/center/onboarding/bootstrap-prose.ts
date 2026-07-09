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

export type TreeSetupBootstrapPlan = "agentSeed" | "useBoundTree" | "createBinding";

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
  if (opts.treeBindingPlan === "agentSeed") {
    // Visible, user-voice task text (onboarding kickoff contract: no skill names
    // / hidden directives). The agent reaches first-tree-seed from the tree-less
    // family map + skill descriptions, and seed adapts to the tree's ACTUAL state
    // — creating + binding it from zero, or filling a bound-but-empty tree. The
    // tree URL is included only as a hint when a binding already exists.
    return [
      "Let's set up our team's shared context.",
      "",
      "Please build out our Context Tree from our connected code — propose an initial structure for me to review, then fill it in.",
      "",
      ...formatSourceList(sourceUrls, "Connected code:"),
      ...(opts.treeUrl ? ["", `Context Tree: ${opts.treeUrl}`] : []),
    ].join("\n");
  }
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

/**
 * First chat for a production-scan fix conversion: the user arrived from the
 * trial's "fix these" CTA. Visible prose only (kickoff contract) — the welcome
 * skill recognizes the scan reference + findings link and launches the fix as
 * the pre-selected first task. `report.first-tree.ai` mirrors the scan skill's
 * BASE constant; the findings JSON expires ~30 days after the scan.
 *
 * `opening: "direct"` is the already-onboarded path (quickstart opens the task
 * chat itself): no "welcome aboard" greeting — the agent isn't being onboarded.
 * Both openings drive the SAME welcome-skill fix launcher (fan the top blockers
 * out into parallel, distinctly-named fix chats, or fix a lone blocker in
 * place). The greeting only signals role: with it, the human is treated as an
 * admin and may get a Context Tree build offer after value; the greeting-free
 * direct path stays role-unclear and makes no admin-only offer.
 */
export function buildScanFixBootstrap(
  agentDisplayName: string,
  handoff: { repoUrl: string; reportKey: string | null },
  opening: "onboarding" | "direct" = "onboarding",
): string {
  const reportLines = handoff.reportKey
    ? [
        `Hosted report: https://report.first-tree.ai/${handoff.reportKey}.html`,
        `Machine-readable findings: https://report.first-tree.ai/${handoff.reportKey}.json`,
      ]
    : [];
  const closing = handoff.reportKey
    ? "Start from the machine-readable findings and fix the blockers in severity order. If the findings link has expired, or the repository isn't accessible from here, say exactly what is needed — a re-run of the scan, the narrowest GitHub access, or a local path."
    : "The scan report link didn't carry over, so start by checking access to the repository, then ask me to share the report or re-run the scan.";
  const openingLines =
    opening === "direct"
      ? [`${agentDisplayName}, please help me fix the launch blockers found by my production readiness scan.`]
      : [
          `${agentDisplayName}, welcome aboard.`,
          "",
          "Please help me fix the launch blockers found by my production readiness scan.",
        ];
  return [...openingLines, "", `Repository: ${handoff.repoUrl}`, ...reportLines, "", closing].join("\n");
}
