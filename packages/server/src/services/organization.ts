import type { CreateOrganizationInput, UpdateOrganization } from "@first-tree/shared";
import { and, count, eq, ne } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
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
  const [org] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, id), eq(organizations.status, "active")))
    .limit(1);
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

  try {
    const [org] = await db
      .update(organizations)
      .set(updates)
      .where(and(eq(organizations.id, id), eq(organizations.status, "active")))
      .returning();

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

async function readOrganizationDeletionImpact(db: Pick<Database, "select">, id: string) {
  const [memberRow] = await db
    .select({ value: count() })
    .from(members)
    .where(and(eq(members.organizationId, id), eq(members.status, "active")));
  const [agentRow] = await db
    .select({ value: count() })
    .from(agents)
    .where(and(eq(agents.organizationId, id), ne(agents.status, "deleted")));

  return {
    activeMemberCount: memberRow?.value ?? 0,
    agentCount: agentRow?.value ?? 0,
    historyRetained: true as const,
  };
}

export async function previewOrganizationDeletion(db: Database, id: string) {
  const org = await getOrganization(db, id);
  if (org.name === "default") {
    throw new BadRequestError('The reserved "default" organization cannot be deleted');
  }

  return readOrganizationDeletionImpact(db, id);
}

export async function deleteOrganization(db: Database, id: string) {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, id), eq(organizations.status, "active")))
      .limit(1);
    if (!org) {
      throw new NotFoundError(`Organization "${id}" not found`);
    }
    if (org.name === "default") {
      throw new BadRequestError('The reserved "default" organization cannot be deleted');
    }

    const now = new Date();
    await tx
      .update(organizations)
      .set({ status: "deleted", name: `deleted-${id}`, updatedAt: now })
      .where(and(eq(organizations.id, id), eq(organizations.status, "active")));
    await tx
      .update(githubAppInstallations)
      .set({ hubOrganizationId: null, updatedAt: now })
      .where(eq(githubAppInstallations.hubOrganizationId, id));
    const agentRows = await tx
      .update(agents)
      .set({ status: "deleted", name: null, updatedAt: now })
      .where(and(eq(agents.organizationId, id), ne(agents.status, "deleted")))
      .returning({ id: agents.uuid });
    const memberRows = await tx
      .update(members)
      .set({ status: "left" })
      .where(and(eq(members.organizationId, id), eq(members.status, "active")))
      .returning({ id: members.id });

    return {
      activeMemberCount: memberRows.length,
      agentCount: agentRows.length,
      historyRetained: true as const,
    };
  });
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
