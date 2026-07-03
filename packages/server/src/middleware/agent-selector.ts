import { AGENT_RUNTIME_SESSION_HEADER, AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { ForbiddenError, UnauthorizedError } from "../errors.js";
import { validateAgentRuntimeSession } from "../services/connection-manager.js";

type AgentSelectorOptions = {
  enforceRuntimeSession?: boolean;
  logger?: {
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
};

const legacyRuntimeHttpWarnedAgentIds = new Set<string>();

/**
 * Agent-scoped HTTP authentication hook. Must run **after** userAuthHook
 * so `request.user` is populated.
 *
 * Contract:
 *   1. Reads `X-Agent-Id` header.
 *   2. Loads the referenced agent (must be active).
 *   3. Verifies the caller has an active membership in the agent's org —
 *      cross-org access is allowed under one user, but a revoked membership
 *      refuses immediately (multi-org switch-org fix).
 *   4. Applies Rule R-RUN — the agent's pinned client must be owned by the
 *      caller's user (non-human agents only). Human agents check that the
 *      member's `agentId` matches.
 *   5. Populates `request.agent` so downstream handlers can keep using the
 *      same `AgentIdentity` shape.
 */
export function agentSelectorHook(db: Database, options: AgentSelectorOptions = {}) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const user = request.user;
    if (!user) {
      // userAuthHook should already have rejected the request; fail loudly
      // if we ever wire routes in the wrong order.
      throw new UnauthorizedError("User authentication required");
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

    if (row.status !== "active") {
      throw new ForbiddenError("Agent is not active");
    }

    // Verify the caller has an active membership in the agent's own org.
    // No JWT default-org coupling — cross-org under a single user is
    // allowed; a revoked membership refuses immediately.
    const [callerMember] = await db
      .select({ id: members.id, agentId: members.agentId })
      .from(members)
      .where(
        and(
          eq(members.userId, user.userId),
          eq(members.organizationId, row.organizationId),
          eq(members.status, "active"),
        ),
      )
      .limit(1);
    if (!callerMember) {
      throw new ForbiddenError("Agent belongs to an organization the caller is not a member of");
    }

    // Human agents represent the member themselves; the caller must BE that
    // member (their members.agent_id must match the agent UUID).
    if (row.type === "human") {
      if (callerMember.agentId !== row.uuid) {
        throw new ForbiddenError("Agent not runnable by this user");
      }
    } else if (!row.clientId || !row.clientUserId || row.clientUserId !== user.userId) {
      // Rule R-RUN: non-human agents must be pinned to a client owned by the
      // caller's user.
      throw new ForbiddenError("Agent not runnable by this user");
    } else {
      const runtimeSessionToken = request.headers[AGENT_RUNTIME_SESSION_HEADER];
      if (typeof runtimeSessionToken === "string" && runtimeSessionToken.length > 0) {
        if (!validateAgentRuntimeSession(row.uuid, row.clientId, runtimeSessionToken)) {
          throw new ForbiddenError("Invalid agent runtime session");
        }
      } else if (options.enforceRuntimeSession) {
        throw new ForbiddenError(`Missing ${AGENT_RUNTIME_SESSION_HEADER} header`);
      } else if (!legacyRuntimeHttpWarnedAgentIds.has(row.uuid)) {
        legacyRuntimeHttpWarnedAgentIds.add(row.uuid);
        options.logger?.warn(
          { agentId: row.uuid, clientId: row.clientId },
          "legacy agent-scoped HTTP without runtime session token accepted",
        );
      }
    }

    request.agent = {
      uuid: row.uuid,
      name: row.name,
      organizationId: row.organizationId,
      inboxId: row.inboxId,
      clientId: row.clientId,
    };
  };
}
