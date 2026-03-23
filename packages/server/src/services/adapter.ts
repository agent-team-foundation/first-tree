import type { CreateAdapterConfig, UpdateAdapterConfig } from "@agent-hub/shared";
import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { adapterConfigs } from "../db/schema/adapter-configs.js";
import { agents } from "../db/schema/agents.js";
import { AppError, NotFoundError } from "../errors.js";
import { encryptCredentials } from "./crypto.js";

/** Server misconfiguration — not a client error. */
class ConfigurationError extends AppError {
  constructor(message: string) {
    super(503, message);
    this.name = "ConfigurationError";
  }
}

function requireEncryptionKey(key: string | undefined): string {
  if (!key) {
    throw new ConfigurationError("ADAPTER_ENCRYPTION_KEY is not configured on the server");
  }
  return key;
}

async function validateAgentId(db: Database, agentId: string): Promise<void> {
  const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) {
    throw new NotFoundError(`Agent "${agentId}" not found`);
  }
}

function toResponse(row: typeof adapterConfigs.$inferSelect) {
  return {
    id: row.id,
    platform: row.platform,
    agentId: row.agentId,
    hasCredentials: row.credentials !== null,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listAdapterConfigs(db: Database) {
  const rows = await db.select().from(adapterConfigs).orderBy(desc(adapterConfigs.createdAt));
  return rows.map(toResponse);
}

export async function getAdapterConfig(db: Database, id: number) {
  const [row] = await db.select().from(adapterConfigs).where(eq(adapterConfigs.id, id)).limit(1);
  if (!row) throw new NotFoundError(`Adapter config "${id}" not found`);
  return toResponse(row);
}

export async function createAdapterConfig(db: Database, data: CreateAdapterConfig, encryptionKey: string | undefined) {
  const key = requireEncryptionKey(encryptionKey);
  if (data.agentId) await validateAgentId(db, data.agentId);
  const encrypted = encryptCredentials(data.credentials, key);

  const [row] = await db
    .insert(adapterConfigs)
    .values({
      platform: data.platform,
      agentId: data.agentId ?? null,
      credentials: encrypted,
      status: data.status ?? "active",
    })
    .returning();

  if (!row) throw new Error("Unexpected: INSERT RETURNING produced no row");
  return toResponse(row);
}

export async function updateAdapterConfig(
  db: Database,
  id: number,
  data: UpdateAdapterConfig,
  encryptionKey: string | undefined,
) {
  const setClause: Record<string, unknown> = { updatedAt: new Date() };

  if (data.agentId !== undefined) {
    if (data.agentId) await validateAgentId(db, data.agentId);
    setClause.agentId = data.agentId ?? null;
  }
  if (data.status !== undefined) setClause.status = data.status;
  if (data.credentials !== undefined) {
    const key = requireEncryptionKey(encryptionKey);
    setClause.credentials = encryptCredentials(data.credentials, key);
  }

  const [row] = await db.update(adapterConfigs).set(setClause).where(eq(adapterConfigs.id, id)).returning();

  if (!row) throw new NotFoundError(`Adapter config "${id}" not found`);
  return toResponse(row);
}

export async function deleteAdapterConfig(db: Database, id: number) {
  const [row] = await db.delete(adapterConfigs).where(eq(adapterConfigs.id, id)).returning();
  if (!row) throw new NotFoundError(`Adapter config "${id}" not found`);
}
