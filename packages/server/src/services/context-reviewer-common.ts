import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";

export type ContextReviewerAgent = {
  uuid: string;
  managerHumanAgentId: string;
  managerGithubLogin: string | null;
};

export function contextReviewerChatReservationKey(organizationId: string, entityKey: string): string {
  const digest = createHash("sha256").update(`${organizationId}\0${entityKey}`).digest("hex");
  return `context-review:${digest}`;
}

export async function loadValidContextReviewerAgent(
  db: Database,
  input: { organizationId: string; reviewerAgentUuid: string },
): Promise<ContextReviewerAgent | null> {
  const [agent] = await db
    .select({
      uuid: agents.uuid,
      managerHumanAgentId: members.agentId,
      managerGithubLogin: sql<string | null>`${authIdentities.metadata}->>'login'`,
    })
    .from(agents)
    .innerJoin(members, eq(members.id, agents.managerId))
    .leftJoin(authIdentities, and(eq(authIdentities.userId, members.userId), eq(authIdentities.provider, "github")))
    .where(
      and(
        eq(agents.uuid, input.reviewerAgentUuid),
        eq(agents.organizationId, input.organizationId),
        eq(agents.type, "agent"),
        eq(agents.status, "active"),
        eq(members.organizationId, input.organizationId),
        eq(members.status, "active"),
      ),
    )
    .limit(1);
  return agent ?? null;
}

export async function findExistingContextReviewerChat(
  db: Database,
  input: { organizationId: string; entityKey: string },
): Promise<string | null> {
  const reservationKey = contextReviewerChatReservationKey(input.organizationId, input.entityKey);
  const [row] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.organizationId, input.organizationId), eq(chats.onboardingKickoffKey, reservationKey)))
    .limit(1);
  return row?.id ?? null;
}
