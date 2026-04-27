import { randomBytes } from "node:crypto";
import type { CreateOrganizationInput, UpdateOrganization } from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";

/**
 * Generate a fresh public invite-link token: 32 random bytes encoded as
 * url-safe base64 with padding stripped (43 chars). Workspace creation uses
 * this so admins can immediately copy the share link from `/admin` → Members.
 *
 * See docs/saas-onboarding-journey.md §2.3.
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/** UUID v7 regex pattern for distinguishing UUIDs from name slugs. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Resolve the UUID of the "default" organization.
 * Used when no organizationId is provided (e.g. agent creation).
 */
export async function resolveDefaultOrgId(db: Database): Promise<string> {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, "default"))
    .limit(1);
  if (!org) {
    throw new Error(
      "Default organization not found. Ensure the server has started and ensureDefaultOrganization() ran.",
    );
  }
  return org.id;
}

export async function createOrganization(db: Database, data: CreateOrganizationInput) {
  const id = uuidv7();
  try {
    const [org] = await db
      .insert(organizations)
      .values({
        id,
        name: data.name,
        displayName: data.displayName,
        maxAgents: data.maxAgents ?? 0,
        maxMessagesPerMinute: data.maxMessagesPerMinute ?? 0,
        features: data.features ?? {},
        inviteToken: generateInviteToken(),
      })
      .returning();

    if (!org) throw new Error("Unexpected: INSERT RETURNING produced no row");
    return org;
  } catch (err) {
    const pgCode = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "";
    if (pgCode === "23505") {
      throw new ConflictError(`Organization with name "${data.name}" already exists`);
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

export async function getOrganizationByName(db: Database, name: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.name, name)).limit(1);
  if (!org) {
    throw new NotFoundError(`Organization "${name}" not found`);
  }
  return org;
}

/**
 * Resolve an organization by UUID or name slug.
 * Tries UUID match first; falls back to name match.
 */
export async function resolveOrganization(db: Database, idOrName: string) {
  if (UUID_PATTERN.test(idOrName)) {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, idOrName)).limit(1);
    if (org) return org;
  }
  // Try by name
  const [org] = await db.select().from(organizations).where(eq(organizations.name, idOrName)).limit(1);
  if (!org) {
    throw new NotFoundError(`Organization "${idOrName}" not found`);
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
  if (data.name !== undefined) updates.name = data.name;
  if (data.displayName !== undefined) updates.displayName = data.displayName;
  if (data.maxAgents !== undefined) updates.maxAgents = data.maxAgents;
  if (data.maxMessagesPerMinute !== undefined) updates.maxMessagesPerMinute = data.maxMessagesPerMinute;
  if (data.features !== undefined) updates.features = data.features;

  try {
    const [org] = await db.update(organizations).set(updates).where(eq(organizations.id, id)).returning();

    if (!org) {
      throw new NotFoundError(`Organization "${id}" not found`);
    }
    return org;
  } catch (err) {
    const pgCode = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "";
    if (pgCode === "23505") {
      throw new ConflictError(`Organization name "${data.name}" is already taken`);
    }
    throw err;
  }
}

export async function deleteOrganization(db: Database, id: string) {
  // Look up the org to check its name
  const [existing] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  if (!existing) {
    throw new NotFoundError(`Organization "${id}" not found`);
  }
  if (existing.name === "default") {
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
 * Uses a fixed UUID for the default org to ensure idempotency.
 */
export async function ensureDefaultOrganization(db: Database) {
  // Check if an org with name "default" already exists
  const [existing] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, "default"))
    .limit(1);

  if (existing) return existing;

  // Create with a new UUID
  const id = uuidv7();
  const [org] = await db
    .insert(organizations)
    .values({
      id,
      name: "default",
      displayName: "Default Organization",
      inviteToken: generateInviteToken(),
    })
    .onConflictDoNothing()
    .returning();

  return org ?? existing;
}
