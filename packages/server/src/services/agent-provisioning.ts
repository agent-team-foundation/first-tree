import { AGENT_ACTOR_HEADER, AGENT_RUNTIME_SESSION_HEADER, AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { ForbiddenError } from "../errors.js";
import { validateAgentRuntimeSession } from "./agent-runtime-session.js";

export type ProvisioningAuditContext = {
  actingAgentId: string;
  managingMemberId: string;
  clientId: string;
  /** Optional related-chat claim; never treated as proof of the initiating turn. */
  chatId: string | null;
};

/** Resolve and prove the standing capability carried by a running agent. */
export async function requireProvisioningActor(
  db: Database,
  request: FastifyRequest,
  organizationId: string,
  userId: string,
): Promise<ProvisioningAuditContext | null> {
  const raw = request.headers[AGENT_ACTOR_HEADER] ?? request.headers[AGENT_SELECTOR_HEADER];
  const actorId = Array.isArray(raw) ? raw[0] : raw;
  const runtimeHeader = request.headers[AGENT_RUNTIME_SESSION_HEADER];
  const runtimeToken = Array.isArray(runtimeHeader) ? runtimeHeader[0] : runtimeHeader;
  if (!actorId && !runtimeToken) return null;
  if (actorId && !runtimeToken) throw new ForbiddenError("Agent provisioning requires an active runtime session");

  const rows = await db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      status: agents.status,
      canProvisionAgents: agents.canProvisionAgents,
      clientId: agents.clientId,
      managerId: agents.managerId,
      managerUserId: members.userId,
      clientUserId: clients.userId,
    })
    .from(agents)
    .innerJoin(members, eq(members.id, agents.managerId))
    .leftJoin(clients, eq(clients.id, agents.clientId))
    .where(
      and(
        eq(members.status, "active"),
        eq(agents.organizationId, organizationId),
        eq(members.userId, userId),
        ...(actorId ? [eq(agents.uuid, actorId)] : []),
      ),
    );

  const actorRow = actorId ? rows[0] : undefined;
  let row: (typeof rows)[number] | undefined;
  if (runtimeToken) {
    for (const candidate of rows) {
      if (
        candidate.type !== "agent" ||
        candidate.status !== "active" ||
        !candidate.clientId ||
        candidate.clientUserId !== userId
      ) {
        continue;
      }
      if (await validateAgentRuntimeSession(db, candidate.uuid, candidate.clientId, runtimeToken)) {
        row = candidate;
        break;
      }
    }
  }
  if (!row || !row.clientId || !runtimeToken) {
    if (actorId && actorRow && runtimeToken) {
      throw new ForbiddenError("Agent provisioning requires an active runtime session");
    }
    if (actorId) throw new ForbiddenError("This agent is not authorized to provision agents");
    throw new ForbiddenError("Agent provisioning requires an active runtime session");
  }
  if (!row.canProvisionAgents) {
    throw new ForbiddenError("This agent is not authorized to provision agents");
  }

  const header = (name: string): string | null => {
    const value = request.headers[name];
    const single = Array.isArray(value) ? value[0] : value;
    return typeof single === "string" && single.length > 0 ? single : null;
  };
  const requestedChatId = header("x-first-tree-chat-id");
  const verifiedChatId = requestedChatId
    ? ((
        await db
          .select({ chatId: chats.id })
          .from(chats)
          .innerJoin(agentChatSessions, eq(agentChatSessions.chatId, chats.id))
          .where(
            and(
              eq(chats.id, requestedChatId),
              eq(chats.organizationId, organizationId),
              eq(agentChatSessions.agentId, row.uuid),
            ),
          )
          .limit(1)
      )[0]?.chatId ?? null)
    : null;

  return {
    actingAgentId: row.uuid,
    managingMemberId: row.managerId,
    clientId: row.clientId,
    chatId: verifiedChatId,
  };
}
