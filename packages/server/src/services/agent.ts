import { randomBytes } from "node:crypto";
import type { CreateAgent, CreateAgentToken, UpdateAgent } from "@agent-team-foundation/first-tree-hub-shared";
import { AGENT_STATUSES } from "@agent-team-foundation/first-tree-hub-shared";
import { and, count, desc, eq, isNull, lt, ne } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { adapterAgentMappings } from "../db/schema/adapter-agent-mappings.js";
import { adapterConfigs } from "../db/schema/adapter-configs.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agentTokens } from "../db/schema/agent-tokens.js";
import { agents } from "../db/schema/agents.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { hashToken } from "../utils.js";
import { uuidv7 } from "../uuid.js";
import { resolveDefaultOrgId } from "./organization.js";

export async function createAgent(db: Database, data: CreateAgent) {
  const uuid = uuidv7();
  const name = data.name ?? null;
  const inboxId = `inbox_${uuid}`;
  const orgId = data.organizationId ?? (await resolveDefaultOrgId(db));

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

  try {
    const [agent] = await db
      .insert(agents)
      .values({
        uuid,
        name,
        organizationId: orgId,
        type: data.type,
        displayName: data.displayName ?? null,
        delegateMention: data.delegateMention ?? null,
        profile: data.profile ?? null,
        inboxId,
        source: data.source ?? null,
        public: data.public ?? false,
        metadata: data.metadata ?? {},
      })
      .returning();

    if (!agent) throw new Error("Unexpected: INSERT RETURNING produced no row");
    return agent;
  } catch (err) {
    // PostgreSQL unique_violation (23505) on UNIQUE(organization_id, name)
    const pgCode = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "";
    if (pgCode === "23505" && name) {
      throw new ConflictError(`Agent name "${name}" already exists in organization "${orgId}"`);
    }
    throw err;
  }
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
      profile: agents.profile,
      inboxId: agents.inboxId,
      status: agents.status,
      cloudUserId: agents.cloudUserId,
      public: agents.public,
      metadata: agents.metadata,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
      presenceStatus: agentPresence.status,
      // M1: runtime fields
      clientId: agentPresence.clientId,
      runtimeType: agentPresence.runtimeType,
      runtimeState: agentPresence.runtimeState,
      runtimeDescription: agentPresence.runtimeDescription,
      activeSessions: agentPresence.activeSessions,
      errorMessage: agentPresence.errorMessage,
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

  const updates: Partial<typeof agents.$inferInsert> = { updatedAt: new Date() };
  if (data.type !== undefined) updates.type = data.type;
  if (data.displayName !== undefined) updates.displayName = data.displayName;
  if (data.delegateMention !== undefined) updates.delegateMention = data.delegateMention;
  if (data.profile !== undefined) updates.profile = data.profile;
  if (data.metadata !== undefined) updates.metadata = data.metadata;

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
 * Suspend an agent. Revokes all active tokens so the agent can no longer authenticate.
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

  // Revoke all active tokens
  await db
    .update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(agentTokens.agentId, uuid), isNull(agentTokens.revokedAt)));

  return agent;
}

/**
 * Delete an agent. Only allowed when status is "suspended".
 * Suspend the agent first to revoke tokens, then delete.
 * Sets name to NULL to release the name for reuse.
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

  // 1. Set status to deleted, release name
  const [agent] = await db
    .update(agents)
    .set({ status: AGENT_STATUSES.DELETED, name: null, updatedAt: new Date() })
    .where(eq(agents.uuid, uuid))
    .returning();

  // 2. Revoke all active tokens (may already be revoked by suspend, but be safe)
  await db
    .update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(agentTokens.agentId, uuid), isNull(agentTokens.revokedAt)));

  // 3. Clean up adapter bindings (bot credentials + user mappings)
  await db.delete(adapterConfigs).where(eq(adapterConfigs.agentId, uuid));
  await db.delete(adapterAgentMappings).where(eq(adapterAgentMappings.agentId, uuid));

  if (!agent) throw new Error("Unexpected: UPDATE RETURNING produced no row");
  return agent;
}

/**
 * Bootstrap a token for an agent using GitHub identity.
 * If the agent does not exist, it is auto-created with the GitHub user as owner.
 * Only works when the agent has no active (non-revoked, non-expired) tokens.
 */
export type BootstrapOptions = {
  tokenName?: string;
  type?: string;
  displayName?: string;
  delegateMention?: string;
  profile?: string;
  metadata?: Record<string, unknown>;
};

export async function bootstrapToken(
  db: Database,
  agentName: string,
  orgId: string,
  githubUsername: string,
  options?: BootstrapOptions,
) {
  // 1. Get or create agent
  let agent: { uuid: string; metadata: Record<string, unknown> | null };
  try {
    agent = await getAgentByName(db, orgId, agentName);
  } catch (err) {
    if (err instanceof NotFoundError) {
      // Auto-create agent with the GitHub user as owner
      const metadata = { ...options?.metadata, owners: [githubUsername] };
      agent = await createAgent(db, {
        name: agentName,
        type: (options?.type as "human" | "personal_assistant" | "autonomous_agent") ?? "autonomous_agent",
        displayName: options?.displayName ?? agentName,
        delegateMention: options?.delegateMention,
        profile: options?.profile,
        organizationId: orgId,
        source: "bootstrap",
        metadata,
      });
    } else {
      throw err;
    }
  }

  // 2. Check agent has owners in metadata
  const owners: string[] = Array.isArray(agent.metadata?.owners) ? (agent.metadata.owners as string[]) : [];
  if (!owners.includes(githubUsername)) {
    throw new ForbiddenError(`GitHub user "${githubUsername}" is not in the owners list for agent "${agentName}"`);
  }

  // 3. Check no active tokens exist (non-revoked = active for bootstrap purposes)
  const activeTokens = await db
    .select({ id: agentTokens.id })
    .from(agentTokens)
    .where(and(eq(agentTokens.agentId, agent.uuid), isNull(agentTokens.revokedAt)));

  if (activeTokens.length > 0) {
    throw new ConflictError(
      `Agent "${agentName}" already has ${activeTokens.length} active token(s). Revoke all tokens first to re-bootstrap.`,
    );
  }

  // 4. Create token
  return createToken(db, agent.uuid, { name: options?.tokenName ?? "bootstrap" });
}

/**
 * Check if a GitHub user belongs to a specific organization.
 */
export async function checkGitHubOrgMembership(githubToken: string, org: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/user/orgs`, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) return false;
  const orgs = (await res.json()) as Array<{ login: string }>;
  return orgs.some((o) => o.login.toLowerCase() === org.toLowerCase());
}

export async function createToken(db: Database, agentUuid: string, data: CreateAgentToken) {
  // Verify agent exists
  await getAgent(db, agentUuid);

  const raw = `aghub_${randomBytes(32).toString("hex")}`;
  const tokenHash = hashToken(raw);
  const tokenId = uuidv7();

  const [token] = await db
    .insert(agentTokens)
    .values({
      id: tokenId,
      agentId: agentUuid,
      tokenHash,
      name: data.name ?? null,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
    })
    .returning();

  if (!token) throw new Error("Unexpected: INSERT RETURNING produced no row");
  return {
    id: token.id,
    agentId: token.agentId,
    name: token.name,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
    token: raw,
  };
}

export async function listTokens(db: Database, agentUuid: string) {
  return db
    .select({
      id: agentTokens.id,
      agentId: agentTokens.agentId,
      name: agentTokens.name,
      expiresAt: agentTokens.expiresAt,
      revokedAt: agentTokens.revokedAt,
      createdAt: agentTokens.createdAt,
      lastUsedAt: agentTokens.lastUsedAt,
    })
    .from(agentTokens)
    .where(eq(agentTokens.agentId, agentUuid))
    .orderBy(desc(agentTokens.createdAt));
}

export async function revokeToken(db: Database, agentUuid: string, tokenId: string) {
  const [token] = await db
    .update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(agentTokens.id, tokenId), eq(agentTokens.agentId, agentUuid), isNull(agentTokens.revokedAt)))
    .returning();

  if (!token) {
    throw new NotFoundError("Token not found or already revoked");
  }
  return token;
}
