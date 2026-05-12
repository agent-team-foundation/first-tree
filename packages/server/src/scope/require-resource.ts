import { AGENT_STATUSES, AGENT_VISIBILITY } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { members } from "../db/schema/members.js";
import { NotFoundError } from "../errors.js";
import { stampAgentResource, stampChatResource, stampOrgScope } from "../observability/request-context.js";
import { requireUser } from "./require-user.js";
import type { OrgScope } from "./types.js";

/**
 * Resource-scoped helpers (Class C). The resource UUID locates the org
 * intrinsically — the URL does NOT carry `:orgId`. Each helper:
 *   1. loads the row by id
 *   2. resolves the caller's active membership in the row's org
 *   3. applies the visibility / manage rule
 *   4. returns `{ resource, scope: OrgScope }` for the handler
 *
 * Returning 404 (not 403) for "not found" / "not visible" / "not in org"
 * is intentional — prevents UUID enumeration.
 */

type AgentRow = {
  uuid: string;
  name: string | null;
  organizationId: string;
  inboxId: string;
  managerId: string;
  status: string;
  visibility: string;
  type: string;
  displayName: string;
  delegateMention: string | null;
  clientId: string | null;
  runtimeProvider: string;
  metadata: Record<string, unknown>;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
};

async function resolveCallerInOrg(
  db: Database,
  userId: string,
  orgId: string,
): Promise<{ memberId: string; role: "admin" | "member"; humanAgentId: string }> {
  const [row] = await db
    .select({ id: members.id, role: members.role, agentId: members.agentId })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, orgId), eq(members.status, "active")))
    .limit(1);
  if (!row) throw new NotFoundError("Resource not found");
  if (row.role !== "admin" && row.role !== "member") {
    throw new NotFoundError("Resource not found");
  }
  return { memberId: row.id, role: row.role, humanAgentId: row.agentId };
}

/**
 * Gate access to a single agent. `kind = "visible"` checks read-style
 * visibility (org-visible OR managed by caller). `kind = "manage"` adds
 * "or caller is admin in agent's org".
 */
export async function requireAgentAccess(
  request: FastifyRequest<{ Params: { uuid: string } }>,
  db: Database,
  kind: "visible" | "manage",
): Promise<{ agent: AgentRow; scope: OrgScope }> {
  const { userId } = requireUser(request);
  const { uuid } = request.params;

  const [agent] = await db.select().from(agents).where(eq(agents.uuid, uuid)).limit(1);
  if (!agent || agent.status === AGENT_STATUSES.DELETED) {
    throw new NotFoundError(`Agent "${uuid}" not found`);
  }

  const caller = await resolveCallerInOrg(db, userId, agent.organizationId);
  const scope: OrgScope = {
    userId,
    organizationId: agent.organizationId,
    memberId: caller.memberId,
    role: caller.role,
    humanAgentId: caller.humanAgentId,
  };

  if (kind === "visible") {
    const orgVisible = agent.visibility === AGENT_VISIBILITY.ORGANIZATION;
    const managed = agent.managerId === caller.memberId;
    if (!orgVisible && !managed) {
      throw new NotFoundError(`Agent "${uuid}" not found`);
    }
  } else {
    // manage: admin in agent's org, OR the agent's manager
    const isAdmin = caller.role === "admin";
    const isManager = agent.managerId === caller.memberId;
    if (!isAdmin && !isManager) {
      throw new NotFoundError(`Agent "${uuid}" not found`);
    }
  }

  stampOrgScope(request, scope);
  stampAgentResource(request, agent);
  return { agent: agent as AgentRow, scope };
}

type ChatRow = {
  id: string;
  organizationId: string;
  type: string;
  topic: string | null;
  lifecyclePolicy: string | null;
  parentChatId: string | null;
  metadata: Record<string, unknown>;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Gate access to a chat. Allowed if the caller's HUMAN agent is a
 * participant, OR any agent the caller manages (via members.id) is a
 * participant. Admin role does NOT auto-grant chat access — chat content
 * remains private to participants and supervisors (their managers).
 *
 * The Params type is generic so routes that mount on a path with extra
 * params (e.g. `/agents/:uuid/sessions/:chatId/...` for compound checks)
 * pass `request` through verbatim without an `as unknown` cast — only
 * `chatId` is read here, every other param is ignored.
 */
export async function requireChatAccess<P extends { chatId: string }>(
  request: FastifyRequest<{ Params: P }>,
  db: Database,
): Promise<{ chat: ChatRow; scope: OrgScope }> {
  const { userId } = requireUser(request);
  // The generic constraint guarantees `chatId` is a string; the cast is
  // here only because Fastify's params type chain erases the `extends`
  // bound when the request flows through hook/handler decorators.
  const { chatId } = request.params as { chatId: string };

  const [chat] = await db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
  if (!chat) throw new NotFoundError(`Chat "${chatId}" not found`);

  const caller = await resolveCallerInOrg(db, userId, chat.organizationId);

  const scope: OrgScope = {
    userId,
    organizationId: chat.organizationId,
    memberId: caller.memberId,
    role: caller.role,
    humanAgentId: caller.humanAgentId,
  };

  // Direct speaker?
  const [direct] = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        eq(chatMembership.agentId, caller.humanAgentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  if (direct) {
    stampOrgScope(request, scope);
    stampChatResource(request, chat);
    return { chat: chat as ChatRow, scope };
  }

  // Supervised speaker — any agent the caller manages.
  const participantRows = await db
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));

  if (participantRows.length === 0) {
    throw new NotFoundError(`Chat "${chatId}" not found`);
  }

  const participantIds = participantRows.map((p) => p.agentId);
  const [managed] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(inArray(agents.uuid, participantIds), eq(agents.managerId, caller.memberId)))
    .limit(1);

  if (!managed) throw new NotFoundError(`Chat "${chatId}" not found`);
  stampOrgScope(request, scope);
  stampChatResource(request, chat);
  return { chat: chat as ChatRow, scope };
}

/**
 * Assert the user can manage the agent identified by `agentUuid`. Returns
 * the agent's org membership scope. Used when a Class C route is keyed on
 * a *related* resource id (e.g. adapter id) and we need to bounce-check
 * the underlying agent's manage rights.
 *
 * Throws 404 for "not found" / "not in org" / "not authorized" — same
 * shape as `requireAgentAccess` to prevent UUID enumeration.
 */
export async function assertAgentManageableByUser(db: Database, userId: string, agentUuid: string): Promise<OrgScope> {
  const [agent] = await db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      managerId: agents.managerId,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.uuid, agentUuid))
    .limit(1);
  if (!agent || agent.status === AGENT_STATUSES.DELETED) {
    throw new NotFoundError(`Agent "${agentUuid}" not found`);
  }
  const caller = await resolveCallerInOrg(db, userId, agent.organizationId);
  const scope: OrgScope = {
    userId,
    organizationId: agent.organizationId,
    memberId: caller.memberId,
    role: caller.role,
    humanAgentId: caller.humanAgentId,
  };
  const isAdmin = caller.role === "admin";
  const isManager = agent.managerId === caller.memberId;
  if (!isAdmin && !isManager) {
    throw new NotFoundError(`Agent "${agentUuid}" not found`);
  }
  return scope;
}

/**
 * Assert every agent in `agentIds` is visible to `scope` and lives in
 * `scope.organizationId`. Used by chat-create to keep visibility rules out of
 * the service layer's signature.
 */
export async function assertAllAgentsVisibleInOrg(db: Database, scope: OrgScope, agentIds: string[]): Promise<void> {
  if (agentIds.length === 0) return;

  const rows = await db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      visibility: agents.visibility,
      managerId: agents.managerId,
      status: agents.status,
    })
    .from(agents)
    .where(inArray(agents.uuid, agentIds));

  const byId = new Map(rows.map((r) => [r.uuid, r]));
  for (const id of agentIds) {
    const row = byId.get(id);
    if (!row || row.status === AGENT_STATUSES.DELETED) {
      throw new NotFoundError(`Agent "${id}" not found`);
    }
    if (row.organizationId !== scope.organizationId) {
      throw new NotFoundError(`Agent "${id}" not found`);
    }
    const orgVisible = row.visibility === AGENT_VISIBILITY.ORGANIZATION;
    const managed = row.managerId === scope.memberId;
    if (!orgVisible && !managed) {
      throw new NotFoundError(`Agent "${id}" not found`);
    }
  }
}
