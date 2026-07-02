/**
 * Campaign registry for reusable landing page → quickstart handoff.
 *
 * Web owns only the public slug allowlist and repo requirement. The actual
 * trial agent, bootstrap message, and skills are server-owned landing campaign
 * catalog data.
 */

export const CAMPAIGN_SLUGS = ["production-scan", "agent-readiness"] as const;
export type CampaignSlug = (typeof CAMPAIGN_SLUGS)[number];

export type CampaignConfig = {
  slug: CampaignSlug;
  needsRepo: boolean;
};

const CAMPAIGNS: Record<CampaignSlug, CampaignConfig> = {
  "production-scan": { slug: "production-scan", needsRepo: true },
  "agent-readiness": { slug: "agent-readiness", needsRepo: true },
};

export function isKnownCampaign(slug: unknown): slug is CampaignSlug {
  return typeof slug === "string" && CAMPAIGN_SLUGS.some((known) => known === slug);
}

export function getCampaign(slug: string | null | undefined): CampaignConfig | null {
  return isKnownCampaign(slug) ? CAMPAIGNS[slug] : null;
}
