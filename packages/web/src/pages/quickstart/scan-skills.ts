import type { CampaignSlug } from "./campaigns.js";
import agentReadinessBody from "./scan-skills/agent-readiness.md?raw";
import productionScanBody from "./scan-skills/production-scan.md?raw";

/**
 * The scan skill each campaign mounts on its quickstart agent. This is the
 * "scan brain" content (authored separately as the product rubric); quickstart
 * only creates it as a team resource + binds it to the agent so the runtime
 * materializes it under `## Team Skills`, then the campaign-aware onboarding
 * directive (server kickoff metadata → client `onboardingSkillDirective`) tells
 * the agent to load and run it on the first chat.
 *
 * `name` matches the campaign slug, so the directive can name the skill and the
 * agent finds it in its briefing. `body` is the SKILL.md content; the runtime's
 * materializer re-adds the YAML frontmatter from `name`/`description`, so the
 * `.md` files hold the body only (no frontmatter).
 */
export type ScanSkill = {
  name: string;
  description: string;
  body: string;
};

export const SCAN_SKILLS: Record<CampaignSlug, ScanSkill> = {
  "production-scan": {
    name: "production-scan",
    description:
      "Use when asked to run a production-readiness / launch-readiness scan on the repository in the current working directory (e.g. a production-scan growth chat). Produces a scored, security-weighted report with the must-fix blockers before shipping.",
    body: productionScanBody,
  },
  "agent-readiness": {
    name: "agent-readiness",
    description:
      "Use when asked to run an agent-readiness scan on the repository in the current working directory (e.g. an agent-readiness growth chat). Assesses how well a coding agent (Claude Code / Codex / Cursor) can work in this repo without getting lost, and names the must-fix blockers.",
    body: agentReadinessBody,
  },
};

export function getScanSkill(campaign: CampaignSlug): ScanSkill {
  return SCAN_SKILLS[campaign];
}
