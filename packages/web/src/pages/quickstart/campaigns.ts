/**
 * Campaign registry for reusable landing page → quickstart handoff.
 *
 * Web owns only the public slug registry and repo requirement. The actual
 * trial agent, bootstrap message, and skills are server-owned landing campaign
 * catalog data.
 */

import {
  isKnownLandingCampaignSlug,
  KNOWN_LANDING_CAMPAIGN_SLUGS,
  type KnownLandingCampaignSlug,
} from "@first-tree/shared";

export const CAMPAIGN_SLUGS = KNOWN_LANDING_CAMPAIGN_SLUGS;
export type CampaignSlug = KnownLandingCampaignSlug;

export type CampaignActionConfig = {
  queryValue: string;
  topic: string;
  request: string;
  reportBaseUrl: string;
  withReportInstruction: string;
  withoutReportInstruction: string;
};

export type CampaignConfig = {
  slug: CampaignSlug;
  needsRepo: boolean;
  action: CampaignActionConfig;
};

const CAMPAIGNS: Record<CampaignSlug, CampaignConfig> = {
  "production-scan": {
    slug: "production-scan",
    needsRepo: true,
    action: {
      queryValue: "fix",
      topic: "Fix production scan blockers",
      request: "fix the launch blockers found by my production readiness scan",
      reportBaseUrl: "https://report.first-tree.ai",
      withReportInstruction:
        "Start from the machine-readable findings and fix the blockers in severity order. If the findings link has expired, or the repository isn't accessible from here, say exactly what is needed — a re-run of the scan, the narrowest GitHub access, or a local path.",
      withoutReportInstruction:
        "The scan report link didn't carry over, so start by checking access to the repository, then ask me to share the report or re-run the scan.",
    },
  },
};

export function isKnownCampaign(slug: unknown): slug is CampaignSlug {
  return isKnownLandingCampaignSlug(slug);
}

export function getCampaign(slug: string | null | undefined): CampaignConfig | null {
  return isKnownCampaign(slug) ? CAMPAIGNS[slug] : null;
}
