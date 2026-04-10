import type { CreateOrganizationInput, UpdateOrganization } from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";

export async function createOrganization(db: Database, data: CreateOrganizationInput) {
  try {
    const [org] = await db
      .insert(organizations)
      .values({
        id: data.id,
        displayName: data.displayName,
        maxAgents: data.maxAgents ?? 0,
        maxMessagesPerMinute: data.maxMessagesPerMinute ?? 0,
        features: data.features ?? {},
      })
      .returning();

    if (!org) throw new Error("Unexpected: INSERT RETURNING produced no row");
    return org;
  } catch (err) {
    const pgCode = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "";
    if (pgCode === "23505") {
      throw new ConflictError(`Organization "${data.id}" already exists`);
    }
    throw err;
  }
}

export async function getOrganization(db: Database, id: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  if (!org) {
    throw new NotFoundError(`Organization "${id}" not found`);
  }
  return org;
}

export async function listOrganizations(db: Database, limit: number, cursor?: string) {
  const conditions = [];
  if (cursor) conditions.push(lt(organizations.createdAt, new Date(cursor)));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(organizations)
    .where(where)
    .orderBy(desc(organizations.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;

  return { items, nextCursor };
}

export async function updateOrganization(db: Database, id: string, data: UpdateOrganization) {
  const updates: Partial<typeof organizations.$inferInsert> = { updatedAt: new Date() };
  if (data.displayName !== undefined) updates.displayName = data.displayName;
  if (data.maxAgents !== undefined) updates.maxAgents = data.maxAgents;
  if (data.maxMessagesPerMinute !== undefined) updates.maxMessagesPerMinute = data.maxMessagesPerMinute;
  if (data.features !== undefined) updates.features = data.features;

  const [org] = await db.update(organizations).set(updates).where(eq(organizations.id, id)).returning();

  if (!org) {
    throw new NotFoundError(`Organization "${id}" not found`);
  }
  return org;
}

export async function deleteOrganization(db: Database, id: string) {
  if (id === "default") {
    throw new BadRequestError('Cannot delete the "default" organization');
  }

  // Check no active agents exist in this org
  const [activeAgent] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(eq(agents.organizationId, id), ne(agents.status, "deleted")))
    .limit(1);

  if (activeAgent) {
    throw new BadRequestError(`Organization "${id}" still has active agents. Delete or move all agents first.`);
  }

  const [org] = await db.delete(organizations).where(eq(organizations.id, id)).returning();
  if (!org) {
    throw new NotFoundError(`Organization "${id}" not found`);
  }
  return org;
}

/**
 * Ensure the default organization exists. Called on server startup.
 */
export async function ensureDefaultOrganization(db: Database) {
  await db.insert(organizations).values({ id: "default", displayName: "Default Organization" }).onConflictDoNothing();
}
