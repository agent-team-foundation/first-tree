import type {
  AgentType,
  AgentVisibility,
  CreateAgent,
  UpdateAgent,
} from "@agent-team-foundation/first-tree-hub-shared";
import {
  AGENT_NAME_REGEX,
  AGENT_STATUSES,
  AGENT_VISIBILITY,
  DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
  isReservedAgentName,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, count, desc, eq, lt, ne } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { adapterAgentMappings } from "../db/schema/adapter-agent-mappings.js";
import { adapterConfigs } from "../db/schema/adapter-configs.js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import { agentVisibilityCondition, type MemberScope } from "./access-control.js";
import { resolveDefaultOrgId } from "./organization.js";

/**
 * Names beginning with `__` are reserved for Hub-internal pseudo agents
 * (e.g. the task notifier). User-facing creation must not be able to
 * squat on them, otherwise internal traffic could be routed through a
 * real account.
 */
const RESERVED_AGENT_NAME_PREFIX = "__";

/** Default visibility per agent type. */
function defaultVisibility(type: AgentType): AgentVisibility {
  switch (type) {
    case "human":
    case "autonomous_agent":
      return AGENT_VISIBILITY.ORGANIZATION;
    case "personal_assistant":
      return AGENT_VISIBILITY.PRIVATE;
    default:
      return AGENT_VISIBILITY.PRIVATE;
  }
}

/**
 * Resolve + validate the client that will own the new agent.
 *
 * Rule (unified-user-token, post-first-bind relaxation):
 *   - Human agents represent the member themselves and have no runtime; a
 *     missing `clientId` is required and the column stays NULL.
 *   - Non-human agents MAY omit `clientId` at creation; the row stays NULL
 *     and is claimed on the first WS bind (see `api/agent/ws-client.ts`).
 *   - When a non-human agent IS created with a `clientId`, the pinned client
 *     must already be owned by the manager's user (Rule R-RUN).
 */
async function resolveAgentClient(
  db: Database,
  data: { clientId?: string; managerId: string; type: string },
): Promise<string | null> {
  if (data.type === "human") {
    if (data.clientId) {
      throw new BadRequestError("Human agents cannot be pinned to a client");
    }
    return null;
  }

  if (!data.clientId) {
    return null;
  }

  const [manager] = await db
    .select({ userId: members.userId, organizationId: members.organizationId })
    .from(members)
    .where(eq(members.id, data.managerId))
    .limit(1);
  if (!manager) {
    throw new BadRequestError(`Manager "${data.managerId}" not found`);
  }

  const [client] = await db
    .select({ id: clients.id, userId: clients.userId, organizationId: clients.organizationId })
    .from(clients)
    .where(eq(clients.id, data.clientId))
    .limit(1);
  if (!client) {
    throw new BadRequestError(`Client "${data.clientId}" not found`);
  }

  if (!client.userId) {
    throw new BadRequestError(
      `Client "${data.clientId}" has not been claimed by a user yet. Have the operator run ` +
        "`first-tree-hub client connect` on that machine before pinning an agent to it.",
    );
  }
  if (client.organizationId !== manager.organizationId) {
    throw new ForbiddenError(
      `Client "${data.clientId}" belongs to a different organization — pick a client registered in the manager's org.`,
    );
  }
  if (client.userId !== manager.userId) {
    throw new ForbiddenError(
      `Client "${data.clientId}" is not owned by the manager's user — pick a client belonging to that user.`,
    );
  }

  return client.id;
}

/**
 * Pick the first admin member in the org for internal system agents. Throws
 * if the org has no admin — the caller should surface the error so an admin
 * is created before the system tries to register more agents.
 */
async function resolveFallbackManagerId(db: Database, orgId: string): Promise<string> {
  const [row] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, orgId), eq(members.role, "admin")))
    .orderBy(members.createdAt)
    .limit(1);
  if (!row) {
    throw new BadRequestError(
      `Cannot create agent in organization "${orgId}" — no admin member exists. ` +
        "Create an admin member first (see `first-tree-hub onboard`).",
    );
  }
  return row.id;
}

export async function createAgent(db: Database, data: CreateAgent & { managerId?: string }) {
  const uuid = uuidv7();
  const name = data.name ?? null;
  if (name?.startsWith(RESERVED_AGENT_NAME_PREFIX)) {
    throw new BadRequestError(
      `Agent name "${name}" is reserved — names starting with "${RESERVED_AGENT_NAME_PREFIX}" are Hub-internal`,
    );
  }
  if (name && isReservedAgentName(name)) {
    throw new BadRequestError(`Agent name "${name}" is reserved — pick a different one.`);
  }
  const inboxId = `inbox_${uuid}`;

  // Resolve orgId + managerId with a strict "manager owns the org" contract.
  //
  // Three branches:
  //
  //   1. Admin API / onboard — caller passes `managerId` only. We look up the
  //      member and derive `orgId` from their `organization_id`. This is the
  //      M1 fix: previously, when the Web UI POSTed without `organizationId`,
  //      we silently fell back to the `default` org, stranding agents in the
  //      wrong tenant.
  //
  //   2. Bootstrap (services/member.ts::createMember, test helpers) — caller
  //      passes BOTH `managerId` and `organizationId` inside the same
  //      transaction where the member row is being inserted right after the
  //      agent. The member doesn't exist yet in this tx, so a members lookup
  //      would fail. We trust the caller and skip the lookup; DB FK still
  //      enforces the manager_id at commit time.
  //
  //   3. System path (github webhook, task service) — caller omits
  //      `managerId` and passes `organizationId` explicitly. We resolve the
  //      first admin of that org as the manager.
  let orgId: string;
  let managerId: string;

  if (data.managerId && data.organizationId) {
    // Branch 2: trust explicit pair (bootstrap / tests).
    orgId = data.organizationId;
    managerId = data.managerId;
  } else if (data.managerId) {
    // Branch 1: derive orgId from the manager's member row.
    const [manager] = await db
      .select({ id: members.id, organizationId: members.organizationId })
      .from(members)
      .where(eq(members.id, data.managerId))
      .limit(1);
    if (!manager) {
      throw new BadRequestError(`Manager "${data.managerId}" not found`);
    }
    orgId = manager.organizationId;
    managerId = manager.id;
  } else {
    // Branch 3: fall back to explicit org (or legacy default org) + its first
    // admin as the manager.
    orgId = data.organizationId ?? (await resolveDefaultOrgId(db));
    managerId = await resolveFallbackManagerId(db, orgId);
  }

  const clientId = await resolveAgentClient(db, {
    clientId: data.clientId,
    managerId,
    type: data.type,
  });

  // Check organization-level agent quota.
  // NOTE: TOCTOU race — concurrent requests may both pass the check. Acceptable for Phase 1;
  // enforce with a DB-level CHECK constraint or SELECT ... FOR UPDATE in Phase 2 if needed.
  const [org] = await db
    .select({ maxAgents: organizations.maxAgents })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (org && org.maxAgents > 0) {
    const rows = await db
      .select({ value: count() })
      .from(agents)
      .where(and(eq(agents.organizationId, orgId), ne(agents.status, AGENT_STATUSES.DELETED)));
    const activeCount = rows[0]?.value ?? 0;
    if (activeCount >= org.maxAgents) {
      throw new ForbiddenError(
        `Organization "${orgId}" has reached its agent limit (${org.maxAgents}). Upgrade your plan or delete unused agents.`,
      );
    }
  }

  // Phase 2 of the agent-naming refactor promoted `display_name` to NOT NULL
  // and standardized the fallback here so every surface (CLI, server logs,
  // IM bridge, chat roster) sees a populated label without the web-only
  // `useAgentNameMap` cascade. Precedence: explicit non-empty displayName →
  // the agent name → a generic "Unnamed Agent" literal (only reached when
  // the caller omitted both fields, which only happens for bootstrap /
  // system-created agents).
  const resolvedDisplayName = data.displayName?.trim() || name || "Unnamed Agent";

  try {
    const [agent] = await db
      .insert(agents)
      .values({
        uuid,
        name,
        organizationId: orgId,
        type: data.type,
        displayName: resolvedDisplayName,
        delegateMention: data.delegateMention ?? null,
        inboxId,
        source: data.source ?? null,
        visibility: data.visibility ?? defaultVisibility(data.type),
        metadata: data.metadata ?? {},
        managerId,
        clientId,
      })
      .returning();

    if (!agent) throw new Error("Unexpected: INSERT RETURNING produced no row");

    await db
      .insert(agentConfigs)
      .values({
        agentId: agent.uuid,
        version: 1,
        payload: DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
        updatedBy: "system",
      })
      .onConflictDoNothing();

    return agent;
  } catch (err) {
    const pgCode = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "";
    if (pgCode === "23505" && name) {
      throw new ConflictError(`Agent name "${name}" already exists in organization "${orgId}"`);
    }
    throw err;
  }
}

/**
 * Result of a pre-create agent-name availability probe used by the web
 * creation form. The server is authoritative (the POST still validates);
 * this endpoint only trades one DB lookup for a better UX so the user sees
 * "taken" / "reserved" inline while typing instead of after submit.
 *
 * Possible `reason` values:
 *   - `invalid`  — fails `AGENT_NAME_REGEX` (not a well-formed slug)
 *   - `reserved` — matches `__` prefix or `RESERVED_AGENT_NAMES`
 *   - `taken`    — an active or suspended agent already owns the name in this org
 *
 * `available: true` is returned only if none of the above applies. Deleted
 * rows have their `name` nulled in the `deleteAgent` service so the name
 * is recyclable without a tombstone check here.
 */
export type AgentNameAvailability =
  | { available: true }
  | { available: false; reason: "invalid" | "reserved" | "taken" };

export async function checkAgentNameAvailability(
  db: Database,
  orgId: string,
  name: string,
): Promise<AgentNameAvailability> {
  if (!AGENT_NAME_REGEX.test(name)) {
    return { available: false, reason: "invalid" };
  }
  if (isReservedAgentName(name) || name.startsWith(RESERVED_AGENT_NAME_PREFIX)) {
    return { available: false, reason: "reserved" };
  }
  const [existing] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(eq(agents.organizationId, orgId), eq(agents.name, name), ne(agents.status, AGENT_STATUSES.DELETED)))
    .limit(1);
  return existing ? { available: false, reason: "taken" } : { available: true };
}

export async function getAgent(db: Database, uuid: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.uuid, uuid), ne(agents.status, AGENT_STATUSES.DELETED)))
    .limit(1);
  if (!agent) {
    throw new NotFoundError(`Agent "${uuid}" not found`);
  }
  return agent;
}

export async function getAgentByName(db: Database, orgId: string, name: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.organizationId, orgId), eq(agents.name, name), ne(agents.status, AGENT_STATUSES.DELETED)))
    .limit(1);
  if (!agent) {
    throw new NotFoundError(`Agent "${name}" not found in organization "${orgId}"`);
  }
  return agent;
}

export async function listAgents(db: Database, orgId: string, limit: number, cursor?: string, type?: string) {
  const conditions = [ne(agents.status, AGENT_STATUSES.DELETED), eq(agents.organizationId, orgId)];
  if (cursor) conditions.push(lt(agents.createdAt, new Date(cursor)));
  if (type) conditions.push(eq(agents.type, type));
  const where = and(...conditions);

  const rows = await db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      organizationId: agents.organizationId,
      type: agents.type,
      displayName: agents.displayName,
      delegateMention: agents.delegateMention,
      inboxId: agents.inboxId,
      status: agents.status,
      visibility: agents.visibility,
      metadata: agents.metadata,
      managerId: agents.managerId,
      clientId: agents.clientId,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
      presenceStatus: agentPresence.status,
      // M1 runtime columns are still materialised on agent_presence. `clientId`
      // comes from the authoritative agents table (the pinned client).
      runtimeType: agentPresence.runtimeType,
      runtimeState: agentPresence.runtimeState,
      activeSessions: agentPresence.activeSessions,
    })
    .from(agents)
    .leftJoin(agentPresence, eq(agents.uuid, agentPresence.agentId))
    .where(where)
    .orderBy(desc(agents.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

  return { items, nextCursor };
}

/**
 * Admin-only variant: return every non-deleted agent in the org, ignoring
 * the visibility filter. Used by the `/admin` "All Agents" view so a team
 * admin can see and act on private agents owned by other members. The
 * route layer is responsible for gating this to admin callers — the
 * service does not enforce role by itself, but it does enforce org scope
 * and the not-deleted predicate.
 */
export async function listAgentsForAdmin(db: Database, scope: MemberScope, limit: number, cursor?: string) {
  const conditions = [eq(agents.organizationId, scope.organizationId), ne(agents.status, AGENT_STATUSES.DELETED)];
  if (cursor) conditions.push(lt(agents.createdAt, new Date(cursor)));
  const where = and(...conditions);

  const rows = await db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      organizationId: agents.organizationId,
      type: agents.type,
      displayName: agents.displayName,
      delegateMention: agents.delegateMention,
      inboxId: agents.inboxId,
      status: agents.status,
      visibility: agents.visibility,
      metadata: agents.metadata,
      managerId: agents.managerId,
      clientId: agents.clientId,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
      presenceStatus: agentPresence.status,
      runtimeType: agentPresence.runtimeType,
      runtimeState: agentPresence.runtimeState,
      activeSessions: agentPresence.activeSessions,
    })
    .from(agents)
    .leftJoin(agentPresence, eq(agents.uuid, agentPresence.agentId))
    .where(where)
    .orderBy(desc(agents.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

  return { items, nextCursor };
}

/**
 * List agents visible to a specific member.
 * Uses agentVisibilityCondition from access-control (same rules for all roles).
 */
export async function listAgentsForMember(
  db: Database,
  scope: MemberScope,
  limit: number,
  cursor?: string,
  type?: string,
) {
  // agentVisibilityCondition already includes org + status + visibility filtering
  const conditions = [agentVisibilityCondition(scope)];
  if (cursor) conditions.push(lt(agents.createdAt, new Date(cursor)));
  if (type) conditions.push(eq(agents.type, type));

  const where = and(...conditions);

  const rows = await db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      organizationId: agents.organizationId,
      type: agents.type,
      displayName: agents.displayName,
      delegateMention: agents.delegateMention,
      inboxId: agents.inboxId,
      status: agents.status,
      visibility: agents.visibility,
      metadata: agents.metadata,
      managerId: agents.managerId,
      clientId: agents.clientId,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
      presenceStatus: agentPresence.status,
      runtimeType: agentPresence.runtimeType,
      runtimeState: agentPresence.runtimeState,
      activeSessions: agentPresence.activeSessions,
    })
    .from(agents)
    .leftJoin(agentPresence, eq(agents.uuid, agentPresence.agentId))
    .where(where)
    .orderBy(desc(agents.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

  return { items, nextCursor };
}

export async function updateAgent(db: Database, uuid: string, data: UpdateAgent) {
  const agent = await getAgent(db, uuid);

  // `clientId` is one-shot: NULL → ID is allowed (admin claiming an unbound
  // agent for a known client). ID → null and ID → another ID are not —
  // moving a running agent requires delete + recreate.
  if (data.clientId !== undefined) {
    if (data.clientId === null) {
      throw new BadRequestError("clientId cannot be cleared — once bound, an agent stays bound to its client");
    }
    if (agent.clientId !== null && agent.clientId !== data.clientId) {
      throw new BadRequestError(
        "clientId is immutable once set — delete and re-create the agent on the target client to move it",
      );
    }
  }

  const updates: Partial<typeof agents.$inferInsert> = { updatedAt: new Date() };
  if (data.type !== undefined) updates.type = data.type;
  if (data.displayName !== undefined) updates.displayName = data.displayName;
  if (data.delegateMention !== undefined) updates.delegateMention = data.delegateMention;
  if (data.visibility !== undefined) updates.visibility = data.visibility;
  if (data.metadata !== undefined) updates.metadata = data.metadata;

  if (data.managerId !== undefined) {
    if (data.managerId === null) {
      throw new BadRequestError("managerId cannot be cleared — every agent must have a manager");
    }
    const [manager] = await db
      .select({ id: members.id, organizationId: members.organizationId })
      .from(members)
      .where(eq(members.id, data.managerId))
      .limit(1);
    if (!manager) {
      throw new BadRequestError(`Manager "${data.managerId}" not found`);
    }
    if (manager.organizationId !== agent.organizationId) {
      throw new BadRequestError("Manager must belong to the same organization as the agent");
    }
    updates.managerId = data.managerId;
  }

  // First-set clientId (NULL → ID): validate ownership against the agent's
  // current manager. Reuses the resolveAgentClient ownership check so the
  // semantics match agent creation.
  if (data.clientId !== undefined && data.clientId !== null && agent.clientId === null) {
    const resolvedClientId = await resolveAgentClient(db, {
      clientId: data.clientId,
      managerId: updates.managerId ?? agent.managerId,
      type: agent.type,
    });
    if (resolvedClientId !== null) {
      updates.clientId = resolvedClientId;
    }
  }

  const [updated] = await db.update(agents).set(updates).where(eq(agents.uuid, agent.uuid)).returning();

  if (!updated) throw new Error("Unexpected: UPDATE RETURNING produced no row");
  return updated;
}

/**
 * Reactivate a suspended agent.
 */
export async function reactivateAgent(db: Database, uuid: string) {
  const [existing] = await db
    .select({ uuid: agents.uuid, status: agents.status })
    .from(agents)
    .where(eq(agents.uuid, uuid))
    .limit(1);
  if (!existing || existing.status === AGENT_STATUSES.DELETED) {
    throw new NotFoundError(`Agent "${uuid}" not found`);
  }
  if (existing.status !== AGENT_STATUSES.SUSPENDED) {
    throw new BadRequestError("Only suspended agents can be reactivated.");
  }

  const [agent] = await db
    .update(agents)
    .set({ status: AGENT_STATUSES.ACTIVE, updatedAt: new Date() })
    .where(eq(agents.uuid, uuid))
    .returning();

  if (!agent) throw new Error("Unexpected: UPDATE RETURNING produced no row");
  return agent;
}

/**
 * Suspend an agent. Once suspended, Rule R-RUN refuses every runtime bind
 * and every agent-selector-authorised HTTP call.
 */
export async function suspendAgent(db: Database, uuid: string) {
  const [agent] = await db
    .update(agents)
    .set({ status: AGENT_STATUSES.SUSPENDED, updatedAt: new Date() })
    .where(and(eq(agents.uuid, uuid), ne(agents.status, AGENT_STATUSES.DELETED)))
    .returning();

  if (!agent) {
    throw new NotFoundError(`Agent "${uuid}" not found`);
  }

  return agent;
}

/**
 * Delete an agent. Only allowed when status is "suspended". Sets name to NULL
 * so the name becomes reusable.
 */
export async function deleteAgent(db: Database, uuid: string) {
  const [existing] = await db
    .select({ uuid: agents.uuid, status: agents.status })
    .from(agents)
    .where(eq(agents.uuid, uuid))
    .limit(1);
  if (!existing || existing.status === AGENT_STATUSES.DELETED) {
    throw new NotFoundError(`Agent "${uuid}" not found`);
  }
  if (existing.status !== AGENT_STATUSES.SUSPENDED) {
    throw new BadRequestError("Only suspended agents can be deleted. Suspend the agent first.");
  }

  const [agent] = await db
    .update(agents)
    .set({ status: AGENT_STATUSES.DELETED, name: null, updatedAt: new Date() })
    .where(eq(agents.uuid, uuid))
    .returning();

  // Clean up adapter bindings (bot credentials + user mappings)
  await db.delete(adapterConfigs).where(eq(adapterConfigs.agentId, uuid));
  await db.delete(adapterAgentMappings).where(eq(adapterAgentMappings.agentId, uuid));

  if (!agent) throw new Error("Unexpected: UPDATE RETURNING produced no row");
  return agent;
}
