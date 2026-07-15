import { parseLandingCampaignTrialAgentMetadata } from "@first-tree/shared";
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { Config } from "../../config.js";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { chatMembership } from "../../db/schema/chat-membership.js";
import { chats } from "../../db/schema/chats.js";
import { clients } from "../../db/schema/clients.js";
import { members } from "../../db/schema/members.js";
import { ForbiddenError, ServiceUnavailableError } from "../../errors.js";

const TRIAL_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRIAL_QUOTA_EXCEEDED_MESSAGE =
  "You've reached the free trial limit for the last 24 hours. Try again later, or connect your own First Tree workspace to keep going.";

export function isLandingCampaignServiceOrg(config: Config, organizationId: string | null | undefined): boolean {
  const serviceOrgId = config.growth.landingCampaigns?.serviceOrgId;
  return !!organizationId && !!serviceOrgId && organizationId === serviceOrgId;
}

export function isLandingCampaignServiceMembership(
  config: Config,
  row: { userId: string | null | undefined; organizationId: string | null | undefined },
): boolean {
  const serviceConfig = config.growth.landingCampaigns;
  const serviceUserId = serviceConfig?.serviceUserId;
  const serviceOrgId = serviceConfig?.serviceOrgId;
  if (!serviceUserId || !serviceOrgId || row.userId !== serviceUserId) return false;
  if (!row.organizationId) return false;
  return row.organizationId !== serviceOrgId;
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

export async function assertTrialQuota(db: Database, config: Config, userId: string): Promise<void> {
  const maxTrials = config.growth.landingCampaignMaxTrialsPerUserPer24Hours;
  const windowStart = new Date(Date.now() - TRIAL_QUOTA_WINDOW_MS);
  const [usage] = await db
    .select({ count: sql<number>`count(DISTINCT ${chats.id})::int` })
    .from(chats)
    .innerJoin(
      chatMembership,
      and(
        eq(chatMembership.chatId, chats.id),
        eq(chatMembership.role, "owner"),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .innerJoin(members, eq(members.agentId, chatMembership.agentId))
    .where(
      and(
        eq(members.userId, userId),
        sql`${chats.metadata} ? 'landingCampaignTrial'`,
        gte(chats.createdAt, windowStart),
      ),
    );

  if ((usage?.count ?? 0) >= maxTrials) {
    throw new ForbiddenError(TRIAL_QUOTA_EXCEEDED_MESSAGE);
  }
}

export async function assertMemberIsNotLandingCampaignServiceMember(
  db: Database,
  config: Config,
  memberId: string,
  organizationId: string,
): Promise<void> {
  const [member] = await db
    .select({ userId: members.userId, organizationId: members.organizationId })
    .from(members)
    .where(and(eq(members.id, memberId), eq(members.organizationId, organizationId)))
    .limit(1);
  if (member && isLandingCampaignServiceMembership(config, member)) {
    throw new ForbiddenError("First Tree landing campaign service member is managed by First Tree.");
  }
}

export async function assertOfficialLandingCampaignClient(
  db: Database,
  clientId: string,
  serviceUserId: string,
  serviceOrgId: string,
): Promise<void> {
  const [client] = await db
    .select({ id: clients.id, userId: clients.userId, organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client || client.userId !== serviceUserId || client.organizationId !== serviceOrgId) {
    throw new ServiceUnavailableError("Landing campaign official client is not configured in the service organization");
  }
}
