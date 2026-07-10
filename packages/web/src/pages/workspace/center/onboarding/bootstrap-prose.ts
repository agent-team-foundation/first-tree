/**
 * Start-chat bootstrap prose for onboarding-created chats. Prose, not shell
 * recipes: the agent's workspace has the shipped First Tree skills
 * (`first-tree-welcome`, `first-tree-write`, `first-tree-read`,
 * `first-tree-seed`), and those skills own the concrete flow.
 *
 * Work/intro chats are value-first. Tree setup chats are separate and resilient:
 * the agent reads the actual tree and source state, asks for a local path or
 * GitHub URL when necessary, and chooses seed vs read/write from that evidence.
 * A mere binding does not imply a populated tree.
 *
 * Single source of truth: only the start-chat step sends these. If a future surface
 * needs the same prompts, hoist these builders to `packages/shared`.
 */

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

export function buildTreeSetupBootstrap(): string {
  // The setup chat, not the Context tab, resolves the actual tree and source
  // state. Keep the visible task useful when Cloud has no registered repo: the
  // agent can ask for one local checkout or GitHub URL without making GitHub App
  // installation a prerequisite for building the tree.
  return [
    "Let's build or finish our team's Context Tree.",
    "",
    "Please inspect the actual tree state and any source code already readable in this workspace. If no source code is readable, ask me for one local project folder path or GitHub repository URL. Once you have readable code, propose the initial top- and second-level domain structure for my review before writing it. Use this same chat to continue after approval; never restart a populated tree.",
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
