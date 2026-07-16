import { AGENT_STATUSES, AGENT_TYPES, AGENT_VISIBILITY } from "@first-tree/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { gitlabIdentityLinks } from "../db/schema/gitlab-identity-links.js";
import { members } from "../db/schema/members.js";
import { NotFoundError } from "../errors.js";
import { stampAgentResource, stampChatResource, stampOrgScope } from "../observability/request-context.js";
import { selectAgentRowWithRuntime } from "../services/agent.js";
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
  /**
   * Runtime-A business state from `agent_presence.runtime_state`. NULL when
   * the agent has no presence row yet (never bound a runtime client). Used
   * by management surfaces to derive reachability (online/offline) without
   * relying on the legacy `presenceStatus` column. Loaded via the shared
   * `selectAgentRowWithRuntime` projection (services/agent.ts).
   */
  runtimeState: string | null;
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
 * Resolve the caller's active membership in `orgId` without throwing —
 * returns `null` when the caller is not an active member. Use for surfaces
 * that should degrade gracefully (e.g. computing per-event chat access for
 * the org-wide Context usage feed) rather than 404, where the throwing
 * `resolveCallerInOrg` would be wrong.
 */
export async function resolveOrgViewer(
  db: Database,
  userId: string,
  orgId: string,
): Promise<{ memberId: string; humanAgentId: string } | null> {
  const [row] = await db
    .select({ id: members.id, role: members.role, agentId: members.agentId })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, orgId), eq(members.status, "active")))
    .limit(1);
  if (!row || (row.role !== "admin" && row.role !== "member")) return null;
  return { memberId: row.id, humanAgentId: row.agentId };
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

  const agent = await selectAgentRowWithRuntime(db, uuid);
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
    // Admin in the agent's org can read any agent — symmetric with the
    // admin-only `/orgs/:orgId/agents/all` listing that already exposes
    // private agents for cross-member troubleshooting. Without this short
    // circuit, admins see private agents in the list but get 404 on detail.
    const orgVisible = agent.visibility === AGENT_VISIBILITY.ORGANIZATION;
    const managed = agent.managerId === caller.memberId;
    const isAdmin = caller.role === "admin";
    if (!orgVisible && !managed && !isAdmin) {
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
  // Description-freshness column the task-summary detail route serializes
  // (the row genuinely carries it; the guard just exposes a curated view).
  descriptionUpdatedAt: Date | null;
  lifecyclePolicy: string | null;
  parentChatId: string | null;
  metadata: Record<string, unknown>;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Gate access to a chat. Allowed if the caller's HUMAN agent has any
 * `chat_membership` row (speaker OR watcher), OR any agent the caller
 * manages (via members.id) is a speaker. Admin role does NOT auto-grant
 * chat access — chat content remains private to members and supervisors
 * (their managers).
 *
 * Watchers are allowed on the direct-membership branch because they
 * surface in `listMeChats` with their own unread badge and engagement
 * state; chat-scoped per-user operations like read-cursor and
 * watcher→speaker upgrade must be reachable from that surface. Write
 * endpoints that need to refuse watchers rely on `ensureParticipant`
 * or service-layer checks, not on this guard.
 *
 * The supervisor branch is a fallback for callers whose human agent
 * has no direct row but who manage a speaker — e.g. before
 * `recomputeChatWatchers` has materialised the watcher row, or when a
 * member's human agent and managed agent diverge in cross-org chats.
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

  // Direct membership — speaker or watcher. A watcher row grants
  // chat-level access even if the supervisor anchor that produced it
  // is no longer live; pruning stale watcher rows is a separate
  // concern from gating callers who can already see the chat in their
  // own workspace list.
  const [direct] = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, caller.humanAgentId)))
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

export async function requireGitlabConnectionAccess(
  request: FastifyRequest<{ Params: { connectionId: string } }>,
  db: Database,
  kind: "read" | "admin",
): Promise<{ connection: typeof gitlabConnections.$inferSelect; scope: OrgScope }> {
  const { userId } = requireUser(request);
  const [connection] = await db
    .select()
    .from(gitlabConnections)
    .where(eq(gitlabConnections.id, request.params.connectionId))
    .limit(1);
  if (!connection) throw new NotFoundError("GitLab connection not found");
  const caller = await resolveCallerInOrg(db, userId, connection.organizationId);
  if (kind === "admin" && caller.role !== "admin") throw new NotFoundError("GitLab connection not found");
  const scope: OrgScope = {
    userId,
    organizationId: connection.organizationId,
    memberId: caller.memberId,
    role: caller.role,
    humanAgentId: caller.humanAgentId,
  };
  stampOrgScope(request, scope);
  return { connection, scope };
}

export async function requireGitlabIdentityLinkAccess(
  request: FastifyRequest<{ Params: { linkId: string } }>,
  db: Database,
): Promise<{ link: typeof gitlabIdentityLinks.$inferSelect; scope: OrgScope }> {
  const { userId } = requireUser(request);
  const [link] = await db
    .select()
    .from(gitlabIdentityLinks)
    .where(eq(gitlabIdentityLinks.id, request.params.linkId))
    .limit(1);
  if (!link) throw new NotFoundError("GitLab identity link not found");
  const caller = await resolveCallerInOrg(db, userId, link.organizationId);
  if (caller.role !== "admin") throw new NotFoundError("GitLab identity link not found");
  const scope: OrgScope = {
    userId,
    organizationId: link.organizationId,
    memberId: caller.memberId,
    role: caller.role,
    humanAgentId: caller.humanAgentId,
  };
  stampOrgScope(request, scope);
  return { link, scope };
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
 * Assert every agent in `agentIds` is visible to `scope`, lives in
 * `scope.organizationId`, and is eligible to become a new chat participant.
 * Used by chat-create to keep visibility rules out of the service layer's
 * signature.
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
      type: agents.type,
      memberStatus: members.status,
    })
    .from(agents)
    .leftJoin(members, eq(members.agentId, agents.uuid))
    .where(inArray(agents.uuid, agentIds));

  const byId = new Map(rows.map((r) => [r.uuid, r]));
  for (const id of agentIds) {
    const row = byId.get(id);
    const inactiveHumanMirror = row?.type === AGENT_TYPES.HUMAN && row.memberStatus !== "active";
    if (!row || row.status !== AGENT_STATUSES.ACTIVE || inactiveHumanMirror) {
      throw new NotFoundError(`Agent "${id}" not found`);
    }
    if (row.organizationId !== scope.organizationId) {
      throw new NotFoundError(`Agent "${id}" not found`);
    }
    const orgVisible = row.visibility === AGENT_VISIBILITY.ORGANIZATION;
    const managed = row.managerId === scope.memberId;
    // Mirror the requireAgentAccess(visible) admin short-circuit so
    // chat-create that references another member's private agent stays
    // symmetric with the detail-side admin behavior.
    const isAdmin = scope.role === "admin";
    if (!orgVisible && !managed && !isAdmin) {
      throw new NotFoundError(`Agent "${id}" not found`);
    }
  }
}
