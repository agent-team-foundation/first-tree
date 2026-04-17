import { AGENT_SELECTOR_HEADER } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { ForbiddenError, UnauthorizedError } from "../errors.js";

/**
 * Agent-scoped HTTP authentication hook. Must run **after** memberAuthHook
 * so `request.member` is populated.
 *
 * Contract:
 *   1. Reads `X-Agent-Id` header.
 *   2. Loads the referenced agent (must be active, same org as the caller).
 *   3. Applies Rule R-RUN — the agent's pinned client must be owned by the
 *      caller's user. Admin role is *not* a runtime override: to run an agent
 *      on a different machine, the admin must reassign its `clientId` via a
 *      future reassign API; this milestone treats `clientId` as immutable.
 *   4. Populates `request.agent` so downstream handlers can keep using the
 *      same `AgentIdentity` shape the old `agentAuthHook` produced.
 */
export function agentSelectorHook(db: Database) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const member = request.member;
    if (!member) {
      // memberAuthHook should already have rejected the request; fail loudly
      // if we ever wire routes in the wrong order.
      throw new UnauthorizedError("Member authentication required");
    }

    const agentId = request.headers[AGENT_SELECTOR_HEADER];
    if (typeof agentId !== "string" || agentId.length === 0) {
      throw new ForbiddenError(`Missing ${AGENT_SELECTOR_HEADER} header`);
    }

    const [row] = await db
      .select({
        uuid: agents.uuid,
        name: agents.name,
        organizationId: agents.organizationId,
        inboxId: agents.inboxId,
        status: agents.status,
        type: agents.type,
        clientId: agents.clientId,
        clientUserId: clients.userId,
      })
      .from(agents)
      .leftJoin(clients, eq(agents.clientId, clients.id))
      .where(and(eq(agents.uuid, agentId)))
      .limit(1);

    if (!row) {
      throw new ForbiddenError("Agent not found");
    }

    if (row.organizationId !== member.organizationId) {
      throw new ForbiddenError("Agent belongs to a different organization");
    }

    if (row.status !== "active") {
      throw new ForbiddenError("Agent is not active");
    }

    // Human agents represent the member themselves and have no runtime; the
    // caller must BE that member. Skip the client-pin check for them — Rule
    // R-RUN applies to non-human (runtime-backed) agents only.
    if (row.type === "human") {
      const [selfMember] = await db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.userId, member.userId), eq(members.agentId, row.uuid)))
        .limit(1);
      if (!selfMember) {
        throw new ForbiddenError("Agent not runnable by this user");
      }
    } else if (!row.clientId || !row.clientUserId || row.clientUserId !== member.userId) {
      // Rule R-RUN: non-human agents must be pinned to a client owned by the
      // caller. The `clientUserId` null check covers two cases: (a) a legacy
      // client still unclaimed, (b) the agent has no client.
      throw new ForbiddenError("Agent not runnable by this user");
    }

    request.agent = {
      uuid: row.uuid,
      name: row.name,
      organizationId: row.organizationId,
      inboxId: row.inboxId,
    };
  };
}
