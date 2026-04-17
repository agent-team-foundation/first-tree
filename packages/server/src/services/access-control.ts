/**
 * Centralized access control for member-facing APIs.
 *
 * Three independent decisions:
 *   1. assertAgentVisible  — can this member see this agent?
 *   2. assertChatAccess    — can this member access this chat?
 *   3. assertCanManage     — can this member manage (configure/delete) this agent?
 *
 * Plus a SQL condition builder for list queries:
 *   agentVisibilityCondition — WHERE clause for "agents visible to this member"
 *
 * Rules:
 *   - Visibility is role-independent: admin sees the same agents as member.
 *     Admin privilege is expressed through manageability, not visibility.
 *     This means an admin cannot see private agents they don't manage —
 *     this is intentional and matches the design principle
 *     "roster is transparent, workspace is private".
 *   - Manageability distinguishes roles: admin can manage all, member only their own.
 *   - All conditions include organizationId scoping to prevent cross-org access.
 */

import { AGENT_STATUSES, AGENT_VISIBILITY } from "@agent-team-foundation/first-tree-hub-shared";
import type { SQL } from "drizzle-orm";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatParticipants, chats } from "../db/schema/chats.js";
import { NotFoundError } from "../errors.js";
import { requireMember } from "../middleware/require-identity.js";

// ---------------------------------------------------------------------------
// MemberScope — extracted once per request, passed to all checks
// ---------------------------------------------------------------------------

export type MemberScope = {
  memberId: string;
  humanAgentId: string;
  organizationId: string;
  role: string;
};

/** Extract MemberScope from an authenticated request. Single definition, used by all routes. */
export function memberScope(request: FastifyRequest): MemberScope {
  const m = requireMember(request);
  return { memberId: m.memberId, humanAgentId: m.agentId, organizationId: m.organizationId, role: m.role };
}

// ---------------------------------------------------------------------------
// Agent visibility
// ---------------------------------------------------------------------------

/**
 * SQL WHERE conditions for agents visible to a member.
 * Visibility is the same for all roles:
 *   same org + not deleted + (organization-visible OR managerId = self)
 */
export function agentVisibilityCondition(scope: MemberScope): SQL {
  return and(
    eq(agents.organizationId, scope.organizationId),
    ne(agents.status, AGENT_STATUSES.DELETED),
    or(eq(agents.visibility, AGENT_VISIBILITY.ORGANIZATION), eq(agents.managerId, scope.memberId)),
  ) as SQL;
}

/**
 * Assert a single agent is visible to the member.
 * Single query — returns 404 for both "not found" and "not visible"
 * to prevent UUID enumeration.
 */
export async function assertAgentVisible(db: Database, scope: MemberScope, agentUuid: string): Promise<void> {
  const [row] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(eq(agents.uuid, agentUuid), agentVisibilityCondition(scope)))
    .limit(1);

  if (!row) throw new NotFoundError(`Agent "${agentUuid}" not found`);
}

// ---------------------------------------------------------------------------
// Chat access
// ---------------------------------------------------------------------------

/**
 * Assert the member can access a chat (read detail, read messages).
 * Verifies chat exists (404 if not), then checks:
 *   - The member's human agent is a participant, OR
 *   - Any agent managed by this member is a participant (supervision)
 * Returns 404 for inaccessible chats to prevent enumeration.
 */
export async function assertChatAccess(db: Database, scope: MemberScope, chatId: string): Promise<void> {
  // Verify chat exists
  const [chat] = await db.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat) throw new NotFoundError(`Chat "${chatId}" not found`);

  // Fast path: human agent is a participant
  const [direct] = await db
    .select({ chatId: chatParticipants.chatId })
    .from(chatParticipants)
    .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.agentId, scope.humanAgentId)))
    .limit(1);
  if (direct) return;

  // Supervision: any managed agent is a participant
  const participantRows = await db
    .select({ agentId: chatParticipants.agentId })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, chatId));

  if (participantRows.length === 0) throw new NotFoundError(`Chat "${chatId}" not found`);

  const participantIds = participantRows.map((p) => p.agentId);
  const [managed] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(inArray(agents.uuid, participantIds), eq(agents.managerId, scope.memberId)))
    .limit(1);

  if (!managed) throw new NotFoundError(`Chat "${chatId}" not found`);
}

// ---------------------------------------------------------------------------
// Agent management (role-dependent)
// ---------------------------------------------------------------------------

/**
 * Assert the member can manage (update/delete/token/suspend) an agent.
 * Admin can manage all agents in their org. Non-admin can only manage agents where managerId = self.
 * Always verifies the agent exists and belongs to the same org (throws 404 if not).
 */
export async function assertCanManage(db: Database, scope: MemberScope, agentUuid: string): Promise<void> {
  const [agent] = await db
    .select({ uuid: agents.uuid, managerId: agents.managerId, organizationId: agents.organizationId })
    .from(agents)
    .where(and(eq(agents.uuid, agentUuid), ne(agents.status, AGENT_STATUSES.DELETED)))
    .limit(1);

  if (!agent || agent.organizationId !== scope.organizationId) {
    throw new NotFoundError(`Agent "${agentUuid}" not found`);
  }
  if (scope.role === "admin") return;
  if (agent.managerId !== scope.memberId) {
    throw new NotFoundError(`Agent "${agentUuid}" not found`);
  }
}
