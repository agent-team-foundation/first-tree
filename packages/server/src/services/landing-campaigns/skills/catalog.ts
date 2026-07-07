/**
 * Server-owned campaign registry for reusable landing page campaigns.
 *
 * The production-scan skill content is NOT stored here. A landing-campaign trial
 * agent is told — in its kickoff message (`buildLandingCampaignBootstrap`) — to
 * clone the public skill repo and run it in First Tree trial mode. Nothing is
 * materialized, bound, or SHA-pinned server-side: the agent clones the skill's
 * default branch at session time and follows it. This keeps the trial on the
 * exact same skill version standalone users get, and keeps the skill a single
 * source of truth in its own public repo.
 *
 * This module therefore only owns the small per-campaign registry (agent name,
 * display name, chat topic, and the public skill repo to clone) plus the
 * kickoff message that carries the clone-and-run directive.
 */

export type LandingCampaignSkillSet = {
  id: string;
  version: string;
  runtimeProvider: "codex";
  agentName: string;
  agentDisplayName: string;
  chatTopic: string;
  /** Public repo the trial agent clones to load and run the campaign skill. */
  skillRepoUrl: string;
};

const LANDING_CAMPAIGN_SKILL_SET_VERSION = "2026.07.07.1";

type LandingCampaignDefinition = Omit<LandingCampaignSkillSet, "id" | "version" | "runtimeProvider">;

const LANDING_CAMPAIGNS: Record<string, LandingCampaignDefinition> = {
  "production-scan": {
    agentName: "production-scanner",
    agentDisplayName: "Production Scanner",
    chatTopic: "Production readiness scan",
    skillRepoUrl: "https://github.com/agent-team-foundation/launch-readiness-scan",
  },
};

export function getLandingCampaignSkillSet(campaign: string): LandingCampaignSkillSet | null {
  const definition = LANDING_CAMPAIGNS[campaign];
  if (!definition) return null;
  return {
    id: campaign,
    version: LANDING_CAMPAIGN_SKILL_SET_VERSION,
    runtimeProvider: "codex",
    ...definition,
  };
}

export function buildLandingCampaignBootstrap(skillSet: LandingCampaignSkillSet, repoUrl: string): string {
  return [
    `Welcome to First Tree. ${skillSet.agentDisplayName} is connected to your code: ${repoUrl}`,
    "",
    "It's giving your code a safe, read-only check before launch — you'll get a score, the problems that actually matter, and a ready-to-use fix for the biggest one.",
    "",
    `${skillSet.agentDisplayName} — clone ${skillSet.skillRepoUrl} and run its production-scan skill on the repo above, in First Tree trial mode.`,
  ].join("\n");
}
