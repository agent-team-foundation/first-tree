import type { CreateOrganizationInput, UpdateOrganization } from "@agent-team-foundation/first-tree-hub-shared";
import { eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { organizations } from "../db/schema/organizations.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";

/**
 * Resolve the UUID of the "default" organization. Internal use only —
 * webhooks, fallbacks, etc. The HTTP API layer no longer falls back to
 * the JWT default org.
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

/**
 * Insert an organizations row. Internal helper for tests and webhook
 * provisioning paths; no longer exposed via the HTTP API.
 */
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

export async function updateOrganization(db: Database, id: string, data: UpdateOrganization) {
  const updates: Partial<typeof organizations.$inferInsert> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.displayName !== undefined) updates.displayName = data.displayName;
  if (data.maxAgents !== undefined) updates.maxAgents = data.maxAgents;
  if (data.maxMessagesPerMinute !== undefined) updates.maxMessagesPerMinute = data.maxMessagesPerMinute;
  if (data.features !== undefined) updates.features = data.features;
  // Pass `null` to explicitly unbind; pass a string to bind. Drizzle treats
  // `undefined` as "no change" so omitting the field from the PATCH body
  // leaves the existing binding alone.
  if (data.treeUrl !== undefined) updates.treeUrl = data.treeUrl;

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
    .values({ id, name: "default", displayName: "Default Organization" })
    .onConflictDoNothing()
    .returning();

  return org ?? existing;
}
