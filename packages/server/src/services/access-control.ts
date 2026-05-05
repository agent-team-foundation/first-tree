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
import { members } from "../db/schema/members.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { requireMember } from "../middleware/require-identity.js";

// ---------------------------------------------------------------------------
// MemberScope — extracted once per request, passed to all checks
// ---------------------------------------------------------------------------

export type MemberScope = {
  userId: string;
  memberId: string;
  humanAgentId: string;
  organizationId: string;
  role: string;
};

/** Extract MemberScope from an authenticated request. Single definition, used by all routes. */
export function memberScope(request: FastifyRequest): MemberScope {
  const m = requireMember(request);
  return {
    userId: m.userId,
    memberId: m.memberId,
    humanAgentId: m.agentId,
    organizationId: m.organizationId,
    role: m.role,
  };
}

// ---------------------------------------------------------------------------
// Agent visibility
// ---------------------------------------------------------------------------

/**
 * SQL WHERE conditions for agents visible to a member.
 * Visibility is the same for all roles:
 *   target org + not deleted + (organization-visible OR managerId = caller's member)
 *
 * Takes explicit `orgId` + `memberId` rather than reading them from
 * MemberScope: an admin viewing a non-default org passes
 * `requireMemberInOrg(db, request, orgId).memberId` to derive the right
 * memberId for that org (decouple-client-from-identity §4.5.1).
 */
export function agentVisibilityCondition(orgId: string, memberId: string): SQL {
  return and(
    eq(agents.organizationId, orgId),
    ne(agents.status, AGENT_STATUSES.DELETED),
    or(eq(agents.visibility, AGENT_VISIBILITY.ORGANIZATION), eq(agents.managerId, memberId)),
  ) as SQL;
}

/**
 * Assert a single agent is visible to the caller.
 *
 * The agent is identified by UUID, so its organization is *intrinsic to the
 * row itself* — we don't gate on the JWT default org. Instead we resolve the
 * caller's active membership in `agent.organizationId` and reuse the same
 * visibility rule (organization-visible OR managerId = caller's member in
 * that org). This lets a multi-org user hit `/admin/agents/:uuid` for an
 * agent in a non-default org without re-issuing the JWT — `/auth/switch-org`
 * now returns 204 only and the web client carries the selected org in
 * localStorage (decouple-client-from-identity §C.2 / §D fix).
 *
 * Returns 404 for both "not found" and "not visible" to prevent UUID
 * enumeration.
 */
export async function assertAgentVisible(db: Database, scope: MemberScope, agentUuid: string): Promise<void> {
  const [agent] = await db
    .select({ uuid: agents.uuid, organizationId: agents.organizationId, status: agents.status })
    .from(agents)
    .where(eq(agents.uuid, agentUuid))
    .limit(1);
  if (!agent || agent.status === AGENT_STATUSES.DELETED) {
    throw new NotFoundError(`Agent "${agentUuid}" not found`);
  }

  // Resolve caller's membership in the agent's own org. JWT default
  // org/memberId may belong to a different org — irrelevant for visibility.
  const [member] = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.userId, scope.userId),
        eq(members.organizationId, agent.organizationId),
        eq(members.status, "active"),
      ),
    )
    .limit(1);
  if (!member) throw new NotFoundError(`Agent "${agentUuid}" not found`);

  const [row] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(eq(agents.uuid, agentUuid), agentVisibilityCondition(agent.organizationId, member.id)))
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
 * Assert the caller can manage (update/delete/token/suspend) an agent.
 *
 * Manageability is anchored on the agent's *own* organization, not on the
 * JWT default org. We resolve the caller's active membership in
 * `agent.organizationId` and grant manage access if either:
 *   - that membership is `admin` (admin in the agent's org), or
 *   - the agent's `managerId` equals the caller's memberId *in that org*.
 *
 * This is the cross-org switch-org fix: with `/auth/switch-org` now 204 the
 * scope.organizationId / scope.memberId are JWT defaults, so the previous
 * `agent.organizationId !== scope.organizationId` short-circuit was 404'ing
 * every `:uuid` route as soon as the user looked at a non-default org. We
 * authorize against the agent's actual org instead.
 *
 * Returns 404 for "not found", "not a member of agent's org", or "not
 * authorized" — same shape as before, to prevent UUID enumeration.
 */
export async function assertCanManage(db: Database, scope: MemberScope, agentUuid: string): Promise<void> {
  const [agent] = await db
    .select({ uuid: agents.uuid, managerId: agents.managerId, organizationId: agents.organizationId })
    .from(agents)
    .where(and(eq(agents.uuid, agentUuid), ne(agents.status, AGENT_STATUSES.DELETED)))
    .limit(1);
  if (!agent) {
    throw new NotFoundError(`Agent "${agentUuid}" not found`);
  }

  // Realtime membership probe in the agent's own org.
  const [memberRow] = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(
      and(
        eq(members.userId, scope.userId),
        eq(members.organizationId, agent.organizationId),
        eq(members.status, "active"),
      ),
    )
    .limit(1);
  if (!memberRow) {
    throw new NotFoundError(`Agent "${agentUuid}" not found`);
  }

  if (memberRow.role === "admin") return;
  if (agent.managerId === memberRow.id) return;

  throw new NotFoundError(`Agent "${agentUuid}" not found`);
}

/**
 * Assert the request's authenticated user has an active membership in
 * `orgId` and return its `(memberId, role)`. Used by admin routes that
 * accept an explicit `organizationId` from the request (query / body /
 * path) and must verify role realtime — JWT `organizationId` and `role`
 * claims are hints, not authoritative (decouple-client-from-identity §4.5).
 *
 * Throws {@link ForbiddenError} if the user is not an active member of the
 * target org.
 */
export async function requireMemberInOrg(
  db: Database,
  request: FastifyRequest,
  orgId: string,
): Promise<{ memberId: string; role: string }> {
  const m = requireMember(request);
  const [row] = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.userId, m.userId), eq(members.organizationId, orgId), eq(members.status, "active")))
    .limit(1);
  if (!row) {
    throw new ForbiddenError("Not an active member of the target organization");
  }
  return { memberId: row.id, role: row.role };
}

/**
 * Resolve the `(organizationId, memberId, role)` an admin route should
 * operate against, based on the unified PR-D scoping rule:
 *   - If the request supplies `?organizationId=…` (query) or it appears in
 *     the body, verify the caller is an active member there and return
 *     that membership realtime.
 *   - Otherwise fall back to the JWT default org (the existing
 *     `MemberScope` from `memberScope(request)`).
 *
 * All admin listing routes call this so that the cross-org switch — driven
 * entirely client-side via `localStorage.selectedOrganizationId` after
 * `/auth/switch-org` returns 204 — funnels through one consistent gate
 * (decouple-client-from-identity §4.5 / §D, codex P1 #2 fix).
 *
 * @returns the effective scope for the rest of the route to read from.
 */
export async function resolveAdminScope(
  db: Database,
  request: FastifyRequest,
  scope: MemberScope,
  requestedOrganizationId: string | undefined,
): Promise<MemberScope> {
  if (!requestedOrganizationId || requestedOrganizationId === scope.organizationId) {
    return scope;
  }
  const probe = await requireMemberInOrg(db, request, requestedOrganizationId);
  return {
    ...scope,
    memberId: probe.memberId,
    organizationId: requestedOrganizationId,
    role: probe.role,
  };
}

/**
 * Cross-org listing helper for "agents I personally manage". Used by the
 * CLI `agent list` view (decouple-client-from-identity §4.5.1 case (b)) —
 * the web roster, by contrast, stays org-scoped via
 * {@link agentVisibilityCondition}.
 *
 * Returns every active agent whose manager is an active member of the
 * caller. JOINs `agents → members.id` and filters by `members.user_id`.
 */
export async function listAgentsManagedByUser(
  db: Database,
  userId: string,
): Promise<
  Array<{
    uuid: string;
    name: string | null;
    displayName: string;
    type: string;
    organizationId: string;
    inboxId: string;
    visibility: string;
    runtimeProvider: string;
    clientId: string | null;
  }>
> {
  return db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      displayName: agents.displayName,
      type: agents.type,
      organizationId: agents.organizationId,
      inboxId: agents.inboxId,
      visibility: agents.visibility,
      runtimeProvider: agents.runtimeProvider,
      clientId: agents.clientId,
    })
    .from(agents)
    .innerJoin(members, eq(agents.managerId, members.id))
    .where(and(eq(members.userId, userId), eq(members.status, "active"), ne(agents.status, AGENT_STATUSES.DELETED)));
}
