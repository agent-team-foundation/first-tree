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
 *
 * CONTRACT: a landing CTA MUST percent-encode the `repo` value in the
 * `/quickstart?campaign=…&repo=…` URL. For a logged-out visitor the login
 * round-trip carries that URL through `next`, validated by `safeRedirectPath`
 * — a raw `https://…` repo (with `:` and `//`) is silently dropped to `/`,
 * breaking the funnel; the encoded form survives (see safe-redirect tests).
 */

/**
 * Neutral, task-agnostic default name for the auto-created quickstart agent.
 * It is the user's first long-term agent — scanning is only its first job — so
 * the name is not bound to a repo or task. Created private; renameable later.
 */
export const QUICKSTART_AGENT_NAME = "Cedar";

export const CAMPAIGN_SLUGS = ["production-scan", "agent-readiness"] as const;
export type CampaignSlug = (typeof CAMPAIGN_SLUGS)[number];

export type CampaignBootstrapArgs = {
  agentDisplayName: string;
  repoUrl: string | null;
};

export type CampaignConfig = {
  slug: CampaignSlug;
  topic: string;
  /** Whether the landing requires a repo (all current campaigns scan one). */
  needsRepo: boolean;
  /**
   * The first-chat opening message. DUAL-READER: rendered verbatim to the user
   * and used as the agent's opening trigger, so it stays clean user-facing task
   * copy — no skill names or operational jargon.
   */
  buildBootstrap(args: CampaignBootstrapArgs): string;
};

function buildScanRequest(agentDisplayName: string, repoUrl: string | null, request: string): string {
  const lines = [`${agentDisplayName}, welcome aboard.`, "", request];
  if (repoUrl) lines.push(`- ${repoUrl}`);
  return lines.join("\n");
}

const CAMPAIGNS: Record<CampaignSlug, CampaignConfig> = {
  "production-scan": {
    slug: "production-scan",
    topic: "Production readiness scan",
    needsRepo: true,
    buildBootstrap: ({ agentDisplayName, repoUrl }) =>
      buildScanRequest(agentDisplayName, repoUrl, "Please run a production readiness scan on this repo:"),
  },
  "agent-readiness": {
    slug: "agent-readiness",
    topic: "Agent readiness scan",
    needsRepo: true,
    buildBootstrap: ({ agentDisplayName, repoUrl }) =>
      buildScanRequest(agentDisplayName, repoUrl, "Please check how ready this repo is for coding agents:"),
  },
};

export function isKnownCampaign(slug: unknown): slug is CampaignSlug {
  return typeof slug === "string" && CAMPAIGN_SLUGS.some((known) => known === slug);
}

export function getCampaign(slug: string | null | undefined): CampaignConfig | null {
  return isKnownCampaign(slug) ? CAMPAIGNS[slug] : null;
}
