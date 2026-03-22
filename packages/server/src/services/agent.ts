import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CreateAgent, CreateAgentToken, UpdateAgent } from "@agent-hub/shared";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentTokens } from "../db/schema/agent-tokens.js";
import { agents } from "../db/schema/agents.js";
import { ConflictError, NotFoundError } from "../errors.js";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function createAgent(db: Database, data: CreateAgent) {
  const id = data.id ?? randomUUID();
  const inboxId = `inbox_${id}`;

  const [existing] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, id)).limit(1);
  if (existing) {
    throw new ConflictError(`Agent "${id}" already exists`);
  }

  const [agent] = await db
    .insert(agents)
    .values({
      id,
      organizationId: data.organizationId ?? "default",
      type: data.type,
      displayName: data.displayName ?? null,
      inboxId,
      metadata: data.metadata ?? {},
    })
    .returning();

  // INSERT ... RETURNING always returns a row
  if (!agent) throw new Error("Unexpected: INSERT RETURNING produced no row");
  return agent;
}

export async function getAgent(db: Database, id: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  if (!agent) {
    throw new NotFoundError(`Agent "${id}" not found`);
  }
  return agent;
}

export async function listAgents(db: Database, limit: number, cursor?: string) {
  const where = cursor ? lt(agents.createdAt, new Date(cursor)) : undefined;

  const query = db
    .select()
    .from(agents)
    .where(where)
    .orderBy(desc(agents.createdAt))
    .limit(limit + 1);

  const rows = await query;
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

  return { items, nextCursor };
}

export async function updateAgent(db: Database, id: string, data: UpdateAgent) {
  const [agent] = await db
    .update(agents)
    .set({
      ...(data.displayName !== undefined ? { displayName: data.displayName ?? null } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
      updatedAt: new Date(),
    })
    .where(eq(agents.id, id))
    .returning();

  if (!agent) {
    throw new NotFoundError(`Agent "${id}" not found`);
  }

  // Suspend = revoke all active tokens (design: "停用 = suspended + 吊销所有 Token")
  if (data.status === "suspended") {
    await db
      .update(agentTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(agentTokens.agentId, id), isNull(agentTokens.revokedAt)));
  }

  return agent;
}

export async function deleteAgent(db: Database, id: string) {
  // Delete = suspend + revoke all tokens (per design doc)
  return updateAgent(db, id, { status: "suspended" });
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
