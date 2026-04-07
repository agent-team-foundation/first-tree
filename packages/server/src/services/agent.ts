import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CreateAgent, CreateAgentToken, UpdateAgent } from "@first-tree-hub/shared";
import { AGENT_STATUSES } from "@first-tree-hub/shared";
import { and, desc, eq, isNull, lt, ne } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { adapterAgentMappings } from "../db/schema/adapter-agent-mappings.js";
import { adapterConfigs } from "../db/schema/adapter-configs.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agentTokens } from "../db/schema/agent-tokens.js";
import { agents } from "../db/schema/agents.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function createAgent(db: Database, data: CreateAgent) {
  const id = data.id ?? randomUUID();
  const inboxId = `inbox_${id}`;

  const [existing] = await db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);

  if (existing) {
    if (existing.status !== AGENT_STATUSES.DELETED) {
      throw new ConflictError(`Agent "${id}" already exists`);
    }
    // Overwrite deleted agent — reuse the row
    const [agent] = await db
      .update(agents)
      .set({
        organizationId: data.organizationId ?? "default",
        type: data.type,
        displayName: data.displayName ?? null,
        delegateMention: data.delegateMention ?? null,
        profile: data.profile ?? null,
        status: "active",
        metadata: data.metadata ?? {},
        updatedAt: new Date(),
      })
      .where(eq(agents.id, id))
      .returning();
    if (!agent) throw new Error("Unexpected: UPDATE RETURNING produced no row");
    return agent;
  }

  const [agent] = await db
    .insert(agents)
    .values({
      id,
      organizationId: data.organizationId ?? "default",
      type: data.type,
      displayName: data.displayName ?? null,
      delegateMention: data.delegateMention ?? null,
      profile: data.profile ?? null,
      inboxId,
      metadata: data.metadata ?? {},
    })
    .returning();

  // INSERT ... RETURNING always returns a row
  if (!agent) throw new Error("Unexpected: INSERT RETURNING produced no row");
  return agent;
}

export async function getAgent(db: Database, id: string) {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), ne(agents.status, AGENT_STATUSES.DELETED)))
    .limit(1);
  if (!agent) {
    throw new NotFoundError(`Agent "${id}" not found`);
  }
  return agent;
}

export async function listAgents(db: Database, limit: number, cursor?: string) {
  const notDeleted = ne(agents.status, AGENT_STATUSES.DELETED);
  const where = cursor ? and(notDeleted, lt(agents.createdAt, new Date(cursor))) : notDeleted;

  const rows = await db
    .select({
      id: agents.id,
      organizationId: agents.organizationId,
      type: agents.type,
      displayName: agents.displayName,
      delegateMention: agents.delegateMention,
      profile: agents.profile,
      inboxId: agents.inboxId,
      status: agents.status,
      metadata: agents.metadata,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
      presenceStatus: agentPresence.status,
    })
    .from(agents)
    .leftJoin(agentPresence, eq(agents.id, agentPresence.agentId))
    .where(where)
    .orderBy(desc(agents.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

  return { items, nextCursor };
}

export async function updateAgent(db: Database, id: string, data: UpdateAgent) {
  const agent = await getAgent(db, id);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.type !== undefined) updates.type = data.type;
  if (data.displayName !== undefined) updates.displayName = data.displayName;
  if (data.delegateMention !== undefined) updates.delegateMention = data.delegateMention;
  if (data.profile !== undefined) updates.profile = data.profile;
  if (data.metadata !== undefined) updates.metadata = data.metadata;

  const [updated] = await db.update(agents).set(updates).where(eq(agents.id, agent.id)).returning();

  if (!updated) throw new Error("Unexpected: UPDATE RETURNING produced no row");
  return updated;
}

/**
 * Reactivate a suspended agent.
 */
export async function reactivateAgent(db: Database, id: string) {
  const [existing] = await db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);
  if (!existing || existing.status === AGENT_STATUSES.DELETED) {
    throw new NotFoundError(`Agent "${id}" not found`);
  }
  if (existing.status !== AGENT_STATUSES.SUSPENDED) {
    throw new BadRequestError("Only suspended agents can be reactivated.");
  }

  const [agent] = await db
    .update(agents)
    .set({ status: AGENT_STATUSES.ACTIVE, updatedAt: new Date() })
    .where(eq(agents.id, id))
    .returning();

  if (!agent) throw new Error("Unexpected: UPDATE RETURNING produced no row");
  return agent;
}

/**
 * Suspend an agent. Revokes all active tokens so the agent can no longer authenticate.
 */
export async function suspendAgent(db: Database, id: string) {
  const [agent] = await db
    .update(agents)
    .set({ status: AGENT_STATUSES.SUSPENDED, updatedAt: new Date() })
    .where(and(eq(agents.id, id), ne(agents.status, AGENT_STATUSES.DELETED)))
    .returning();

  if (!agent) {
    throw new NotFoundError(`Agent "${id}" not found`);
  }

  // Revoke all active tokens
  await db
    .update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(agentTokens.agentId, id), isNull(agentTokens.revokedAt)));

  return agent;
}

/**
 * Delete an agent. Only allowed when status is "suspended".
 * Suspend the agent first to revoke tokens, then delete.
 */
export async function deleteAgent(db: Database, id: string) {
  const [existing] = await db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);
  if (!existing || existing.status === AGENT_STATUSES.DELETED) {
    throw new NotFoundError(`Agent "${id}" not found`);
  }
  if (existing.status !== AGENT_STATUSES.SUSPENDED) {
    throw new BadRequestError("Only suspended agents can be deleted. Suspend the agent first.");
  }

  // 1. Set status to deleted
  const [agent] = await db
    .update(agents)
    .set({ status: AGENT_STATUSES.DELETED, updatedAt: new Date() })
    .where(eq(agents.id, id))
    .returning();

  // 2. Revoke all active tokens (may already be revoked by suspend, but be safe)
  await db
    .update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(agentTokens.agentId, id), isNull(agentTokens.revokedAt)));

  // 3. Clean up adapter bindings (bot credentials + user mappings)
  await db.delete(adapterConfigs).where(eq(adapterConfigs.agentId, id));
  await db.delete(adapterAgentMappings).where(eq(adapterAgentMappings.agentId, id));

  if (!agent) throw new Error("Unexpected: UPDATE RETURNING produced no row");
  return agent;
}

/**
 * Bootstrap a token for an agent using GitHub identity.
 * If the agent does not exist, it is auto-created with the GitHub user as owner.
 * Only works when the agent has no active (non-revoked, non-expired) tokens.
 */
export async function bootstrapToken(db: Database, agentId: string, githubUsername: string, tokenName?: string) {
  // 1. Get or create agent
  let agent: { id: string; metadata: Record<string, unknown> | null };
  try {
    agent = await getAgent(db, agentId);
  } catch (err) {
    if (err instanceof NotFoundError) {
      // Auto-create agent with the GitHub user as owner
      agent = await createAgent(db, {
        id: agentId,
        type: "autonomous_agent",
        displayName: agentId,
        metadata: { owners: [githubUsername] },
      });
    } else {
      throw err;
    }
  }

  // 2. Check agent has owners in metadata
  const owners: string[] = Array.isArray(agent.metadata?.owners) ? (agent.metadata.owners as string[]) : [];
  if (!owners.includes(githubUsername)) {
    throw new ForbiddenError(`GitHub user "${githubUsername}" is not in the owners list for agent "${agentId}"`);
  }

  // 3. Check no active tokens exist (non-revoked = active for bootstrap purposes)
  const activeTokens = await db
    .select({ id: agentTokens.id })
    .from(agentTokens)
    .where(and(eq(agentTokens.agentId, agentId), isNull(agentTokens.revokedAt)));

  if (activeTokens.length > 0) {
    throw new ConflictError(
      `Agent "${agentId}" already has ${activeTokens.length} active token(s). Revoke all tokens first to re-bootstrap.`,
    );
  }

  // 4. Create token
  return createToken(db, agentId, { name: tokenName ?? "bootstrap" });
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

export async function createToken(db: Database, agentId: string, data: CreateAgentToken) {
  // Verify agent exists
  await getAgent(db, agentId);

  const raw = `aghub_${randomBytes(32).toString("hex")}`;
  const tokenHash = hashToken(raw);
  const tokenId = randomUUID();

  const [token] = await db
    .insert(agentTokens)
    .values({
      id: tokenId,
      agentId,
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

export async function listTokens(db: Database, agentId: string) {
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
    .where(eq(agentTokens.agentId, agentId))
    .orderBy(desc(agentTokens.createdAt));
}

export async function revokeToken(db: Database, agentId: string, tokenId: string) {
  const [token] = await db
    .update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(agentTokens.id, tokenId), eq(agentTokens.agentId, agentId), isNull(agentTokens.revokedAt)))
    .returning();

  if (!token) {
    throw new NotFoundError("Token not found or already revoked");
  }
  return token;
}
