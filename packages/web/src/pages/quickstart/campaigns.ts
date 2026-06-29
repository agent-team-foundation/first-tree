/**
 * Campaign registry for the reusable quickstart growth entry.
 *
 * Each landing page maps to one campaign slug; the slug is a parameter
 * (`/quickstart?campaign=<slug>&repo=...`), and this registry turns it into the
 * first-chat bootstrap and per-campaign behaviour. Adding a new landing =
 * adding one entry here — the quickstart flow itself does not change.
 *
 * Slugs are kebab-case to match the server's campaign idempotency-key segment
 * (`@first-tree/shared` `kickoffOnboardingSchema.campaign`).
 */

/**
 * Neutral, task-agnostic default name for the auto-created quickstart agent.
 * It is the user's first long-term agent — scanning is only its first job — so
 * the name is not bound to a repo or task. Created private; renameable later.
 */
export const QUICKSTART_AGENT_NAME = "Cedar";

export type CampaignSlug = "production-scan" | "agent-readiness";

export type CampaignBootstrapArgs = {
  agentDisplayName: string;
  repoUrl: string | null;
};

export type CampaignConfig = {
  slug: CampaignSlug;
  /** Whether the landing requires a repo (all current campaigns scan one). */
  needsRepo: boolean;
  /**
   * The first-chat opening message. DUAL-READER: rendered verbatim to the user
   * as the first "First Tree" bubble AND used as the agent's opening trigger,
   * so it stays clean user-facing welcome copy — no skill names or operational
   * jargon. Agent-only activation (which skill to load) rides message metadata,
   * never this body. See system/cloud/onboarding.md "Kickoff Finalization".
   */
  buildBootstrap(args: CampaignBootstrapArgs): string;
};

function buildWelcome(agentDisplayName: string, repoUrl: string | null, closing: string): string {
  const lines = [`Welcome to First Tree — this is your first chat with ${agentDisplayName}.`];
  if (repoUrl) lines.push("", `It's connected to your code: ${repoUrl}`);
  lines.push("", closing);
  return lines.join("\n");
}

const CAMPAIGNS: Record<CampaignSlug, CampaignConfig> = {
  "production-scan": {
    slug: "production-scan",
    needsRepo: true,
    buildBootstrap: ({ agentDisplayName, repoUrl }) =>
      buildWelcome(
        agentDisplayName,
        repoUrl,
        `${agentDisplayName} will get oriented and flag a few things worth tightening before you ship — or just tell it what you'd like to focus on.`,
      ),
  },
  "agent-readiness": {
    slug: "agent-readiness",
    needsRepo: true,
    buildBootstrap: ({ agentDisplayName, repoUrl }) =>
      buildWelcome(
        agentDisplayName,
        repoUrl,
        `${agentDisplayName} will get oriented and point out what makes this repo hard for coding agents to work in — or just tell it what you'd like to focus on.`,
      ),
  },
};

export function isKnownCampaign(slug: unknown): slug is CampaignSlug {
  return typeof slug === "string" && Object.hasOwn(CAMPAIGNS, slug);
}

export function getCampaign(slug: string | null | undefined): CampaignConfig | null {
  return isKnownCampaign(slug) ? CAMPAIGNS[slug] : null;
}
