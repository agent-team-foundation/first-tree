/**
 * Server-owned catalog for reusable landing page campaigns.
 *
 * A campaign entry carries the trial agent's identity (agent name, chat topic)
 * plus the skill repo the agent clones at kickoff. The scan skill body is NOT
 * server-delivered: the bootstrap message tells the trial agent to clone the
 * campaign's skill repo and run the named skill in First Tree trial mode, so
 * the skill content evolves in its own repo without a server release.
 *
 * The web quickstart flow only sends the campaign slug + repo; the server
 * resolves the slug here and seeds the kickoff chat. `version` is provenance
 * metadata stamped onto trial agents/chats (which kickoff contract a trial ran
 * on), not a client re-pull trigger.
 */

export type LandingCampaignSkillSet = {
  id: string;
  version: string;
  agentName: string;
  agentDisplayName: string;
  chatTopic: string;
  /** Repo the trial agent clones to obtain the campaign skill. */
  skillRepoUrl: string;
  /** Skill inside the cloned repo that the bootstrap message names. */
  skillName: string;
};

const LANDING_CAMPAIGN_SKILL_SET_VERSION = "2026.07.07.1";

const LANDING_CAMPAIGN_SKILL_SETS: Record<string, Omit<LandingCampaignSkillSet, "id" | "version">> = {
  "production-scan": {
    agentName: "production-scanner",
    agentDisplayName: "Production Scanner",
    chatTopic: "Production readiness scan",
    skillRepoUrl: "https://github.com/agent-team-foundation/launch-readiness-scan",
    skillName: "production-scan",
  },
};

export function getLandingCampaignSkillSet(campaign: string): LandingCampaignSkillSet | null {
  const entry = LANDING_CAMPAIGN_SKILL_SETS[campaign];
  if (!entry) return null;
  return { id: campaign, version: LANDING_CAMPAIGN_SKILL_SET_VERSION, ...entry };
}

export function buildLandingCampaignBootstrap(skillSet: LandingCampaignSkillSet, repoUrl: string): string {
  return [
    `Welcome to First Tree. ${skillSet.agentDisplayName} is connected to your code: ${repoUrl}`,
    "",
    "It's giving your code a safe, read-only check before launch — you'll get a score, the problems that actually matter, and a ready-to-use fix for the biggest one.",
    "",
    `${skillSet.agentDisplayName} — clone ${skillSet.skillRepoUrl} and run its ${skillSet.skillName} skill on the repo above, in First Tree trial mode.`,
  ].join("\n");
}
