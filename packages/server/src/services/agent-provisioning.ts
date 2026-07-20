import { AGENT_ACTOR_HEADER, AGENT_RUNTIME_SESSION_HEADER, AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { ForbiddenError } from "../errors.js";
import { validateAgentRuntimeSession } from "./agent-runtime-session.js";

export type ProvisioningAuditContext = {
  actingAgentId: string;
  managingMemberId: string;
  chatId: string | null;
  sessionId: string | null;
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
  if (!actorId) return null;
  const runtimeHeader = request.headers[AGENT_RUNTIME_SESSION_HEADER];
  const runtimeToken = Array.isArray(runtimeHeader) ? runtimeHeader[0] : runtimeHeader;
  if (!runtimeToken) throw new ForbiddenError("Agent provisioning requires an active runtime session");

  const [row] = await db
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
    .where(and(eq(agents.uuid, actorId), eq(members.status, "active")))
    .limit(1);

  if (
    !row ||
    row.organizationId !== organizationId ||
    row.managerUserId !== userId ||
    row.type !== "agent" ||
    row.status !== "active" ||
    !row.canProvisionAgents ||
    !row.clientId ||
    row.clientUserId !== userId
  ) {
    throw new ForbiddenError("This agent is not authorized to provision agents");
  }
  if (!(await validateAgentRuntimeSession(db, row.uuid, row.clientId, runtimeToken))) {
    throw new ForbiddenError("Agent provisioning requires an active runtime session");
  }

  const header = (name: string): string | null => {
    const value = request.headers[name];
    const single = Array.isArray(value) ? value[0] : value;
    return typeof single === "string" && single.length > 0 ? single : null;
  };
  return {
    actingAgentId: row.uuid,
    managingMemberId: row.managerId,
    chatId: header("x-first-tree-chat-id"),
    sessionId: header("x-first-tree-session-id"),
  };
}
