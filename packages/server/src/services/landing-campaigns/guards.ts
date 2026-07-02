import { parseLandingCampaignTrialAgentMetadata } from "@first-tree/shared";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Config } from "../../config.js";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { members } from "../../db/schema/members.js";
import { ForbiddenError } from "../../errors.js";

export function isLandingCampaignOfficialClient(config: Config, clientId: string | null | undefined): boolean {
  return !!clientId && clientId === config.growth.landingCampaigns?.clientId;
}

export function isLandingCampaignOfficialUser(config: Config, userId: string | null | undefined): boolean {
  return !!userId && userId === config.growth.landingCampaigns?.serviceUserId;
}

export function assertMetadataDoesNotClaimLandingCampaignTrial(metadata: Record<string, unknown> | undefined): void {
  if (metadata?.landingCampaignTrial === true || (metadata && parseLandingCampaignTrialAgentMetadata(metadata))) {
    throw new ForbiddenError("Landing campaign trial agents are created only by First Tree.");
  }
}

export function assertMutableAgentIsNotLandingCampaignTrial(agent: { metadata: Record<string, unknown> }): void {
  if (parseLandingCampaignTrialAgentMetadata(agent.metadata)) {
    throw new ForbiddenError("Landing campaign trial agents are managed by First Tree.");
  }
}

export async function assertNoLandingCampaignTrialAgents(db: Database, agentIds: readonly string[]): Promise<void> {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return;
  const rows = await db
    .select({ uuid: agents.uuid, displayName: agents.displayName, metadata: agents.metadata })
    .from(agents)
    .where(and(inArray(agents.uuid, ids), ne(agents.status, "deleted")));
  const trial = rows.find((row) => parseLandingCampaignTrialAgentMetadata(row.metadata));
  if (trial) {
    throw new ForbiddenError(
      `Agent "${trial.displayName}" is a single-run landing campaign agent. Start it from the landing page flow.`,
    );
  }
}

export async function assertMemberIsNotLandingCampaignServiceMember(
  db: Database,
  config: Config,
  memberId: string,
): Promise<void> {
  const serviceUserId = config.growth.landingCampaigns?.serviceUserId;
  if (!serviceUserId) return;
  const [member] = await db.select({ userId: members.userId }).from(members).where(eq(members.id, memberId)).limit(1);
  if (member?.userId === serviceUserId) {
    throw new ForbiddenError("First Tree landing campaign service member is managed by First Tree.");
  }
}
