/**
 * Server-owned catalog for reusable landing page campaigns.
 *
 * A campaign entry carries the trial agent's identity (agent name, chat topic)
 * plus the skill repo the agent clones at kickoff. The scan skill body is NOT
 * server-delivered: the bootstrap message tells the trial agent to clone the
 * campaign's skill repo and run the named skill on the connected repo.
 * Nothing is materialized, bound, or SHA-pinned server-side — the agent clones
 * the skill repo's default branch at session time and follows it, so the skill
 * stays a single source of truth in its own repo, evolving without a server
 * release.
 *
 * The web quickstart flow only sends the campaign slug + repo; the server
 * resolves the slug here and seeds the kickoff chat. `version` is provenance
 * metadata stamped onto trial agents/chats (which kickoff contract a trial ran
 * on), not a client re-pull trigger.
 */

import { isKnownLandingCampaignSlug, type KnownLandingCampaignSlug } from "@first-tree/shared";

export type LandingCampaignSkillSet = {
  id: KnownLandingCampaignSlug;
  version: string;
  agentName: string;
  agentDisplayName: string;
  chatTopic: string;
  /** Repo the trial agent clones to obtain the campaign skill. */
  skillRepoUrl: string;
  /** Skill inside the cloned repo that the bootstrap message names. */
  skillName: string;
  /** User-facing explanation shown before the trial agent instruction. */
  trialSummary: string;
  /** User-facing explanation shown when a silent trial is restarted. */
  retrySummary: string;
};

const LANDING_CAMPAIGN_SKILL_SET_VERSION = "2026.07.07.1";

const LANDING_CAMPAIGN_SKILL_SETS: Record<KnownLandingCampaignSlug, Omit<LandingCampaignSkillSet, "id" | "version">> = {
  "production-scan": {
    agentName: "production-scanner",
    agentDisplayName: "Production Scanner",
    chatTopic: "Production readiness scan",
    skillRepoUrl: "https://github.com/agent-team-foundation/launch-readiness-scan",
    skillName: "production-scan",
    trialSummary:
      "It's giving your code a safe, read-only check before launch — you'll get a score, the problems that actually matter, and the exact fix for each one.",
    retrySummary: "The scan didn't get started, so First Tree has restarted it. Same safe, read-only check on:",
  },
};

export function getLandingCampaignSkillSet(campaign: string): LandingCampaignSkillSet | null {
  if (!isKnownLandingCampaignSlug(campaign)) return null;
  const entry = LANDING_CAMPAIGN_SKILL_SETS[campaign];
  return { id: campaign, version: LANDING_CAMPAIGN_SKILL_SET_VERSION, ...entry };
}

export function buildLandingCampaignBootstrap(skillSet: LandingCampaignSkillSet, repoUrl: string): string {
  return [
    `Welcome to First Tree. ${skillSet.agentDisplayName} is connected to your code: ${repoUrl}`,
    "",
    skillSet.trialSummary,
    "",
    `${skillSet.agentDisplayName} — clone ${skillSet.skillRepoUrl} and run its ${skillSet.skillName} skill on the repo above.`,
  ].join("\n");
}

/**
 * Re-kick message for a trial whose run went silent. Self-contained on
 * purpose: the runtime session may be brand new (lost rollout), so the repo
 * URL, skill repo, and skill name must all be restated rather than referring
 * to "the repo above".
 */
export function buildLandingCampaignRetryBootstrap(skillSet: LandingCampaignSkillSet, repoUrl: string): string {
  return [
    `${skillSet.retrySummary} ${repoUrl}`,
    "",
    `${skillSet.agentDisplayName} — if a scan is already in progress in this chat, continue where you left off. Otherwise clone ${skillSet.skillRepoUrl} and run its ${skillSet.skillName} skill on ${repoUrl}.`,
  ].join("\n");
}
