import { randomBytes } from "node:crypto";
import type { CreateMember, UpdateMember } from "@agent-team-foundation/first-tree-hub-shared";
import bcrypt from "bcrypt";
import { and, desc, eq, ne } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import { createAgent } from "./agent.js";

const SALT_ROUNDS = 10;

/**
 * Create a member in an organization.
 * Creates user (if needed) + member + human agent in one transaction.
 * Returns the member info plus a one-time plaintext password (only when user is new).
 */
export async function createMember(db: Database, orgId: string, data: CreateMember) {
  // Check if user with this username already exists
  const [existingUser] = await db.select().from(users).where(eq(users.username, data.username)).limit(1);

  if (existingUser) {
    // Check if already a member of this org
    const [existingMember] = await db
      .select()
      .from(members)
      .where(and(eq(members.userId, existingUser.id), eq(members.organizationId, orgId)))
      .limit(1);
    if (existingMember) {
      throw new ConflictError(`User "${data.username}" is already a member of this organization`);
    }
  }

  // Generate password only for new users
  const isNewUser = !existingUser;
  const password = isNewUser ? randomBytes(12).toString("base64url") : null;
  const passwordHash = password ? await bcrypt.hash(password, SALT_ROUNDS) : null;

  return db.transaction(async (tx) => {
    // Create user if needed
    const userId = existingUser?.id ?? uuidv7();
    if (isNewUser && passwordHash) {
      await tx.insert(users).values({
        id: userId,
        username: data.username,
        passwordHash,
        displayName: data.displayName,
      });
    }

    // Compute the member id up-front so we can set `agents.manager_id` to it
    // at insert time (managerId is NOT NULL since the unified-user-token
    // milestone). The human agent self-manages.
    const memberId = uuidv7();
    const agentName = data.username.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
    const agent = await createAgent(tx as unknown as Database, {
      name: agentName,
      type: "human",
      displayName: data.displayName,
      organizationId: orgId,
      source: "admin-api",
      managerId: memberId,
    });

    const [member] = await tx
      .insert(members)
      .values({
        id: memberId,
        userId,
        organizationId: orgId,
        agentId: agent.uuid,
        role: data.role ?? "member",
      })
      .returning();

    if (!member) throw new Error("Unexpected: INSERT RETURNING produced no row");

    return {
      id: member.id,
      userId: member.userId,
      organizationId: member.organizationId,
      agentId: member.agentId,
      role: member.role,
      createdAt: member.createdAt.toISOString(),
      username: data.username,
      displayName: data.displayName,
      // Only return password for new users
      ...(password ? { password } : { notice: "Existing user — use their current password to log in" }),
    };
  });
}

export async function listMembers(db: Database, orgId: string) {
  const rows = await db
    .select({
      id: members.id,
      userId: members.userId,
      organizationId: members.organizationId,
      agentId: members.agentId,
      role: members.role,
      createdAt: members.createdAt,
      username: users.username,
      displayName: users.displayName,
    })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(eq(members.organizationId, orgId))
    .orderBy(desc(members.createdAt));

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getMember(db: Database, id: string) {
  const [row] = await db
    .select({
      id: members.id,
      userId: members.userId,
      organizationId: members.organizationId,
      agentId: members.agentId,
      role: members.role,
      createdAt: members.createdAt,
      username: users.username,
      displayName: users.displayName,
    })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(eq(members.id, id))
    .limit(1);

  if (!row) throw new NotFoundError(`Member "${id}" not found`);
  return { ...row, createdAt: row.createdAt.toISOString() };
}

export async function updateMember(db: Database, id: string, data: UpdateMember) {
  if (!data.role) return getMember(db, id);

  // Prevent demoting the last admin
  if (data.role === "member") {
    const member = await getMember(db, id);
    if (member.role === "admin") {
      await assertNotLastAdmin(db, member.organizationId, id);
    }
  }

  const [row] = await db.update(members).set({ role: data.role }).where(eq(members.id, id)).returning();

  if (!row) throw new NotFoundError(`Member "${id}" not found`);
  return getMember(db, id);
}

export async function deleteMember(db: Database, id: string) {
  const member = await getMember(db, id);

  // Prevent deleting the last admin
  if (member.role === "admin") {
    await assertNotLastAdmin(db, member.organizationId, id);
  }

  // Reassign every agent managed by this member to another admin in the org.
  // managerId is NOT NULL after the unified-user-token milestone, so we can
  // never clear it — a sibling admin takes over (assertNotLastAdmin above
  // guarantees at least one remains).
  const [fallback] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, member.organizationId), eq(members.role, "admin"), ne(members.id, id)))
    .limit(1);
  if (!fallback) {
    throw new ConflictError(
      `Cannot delete member "${id}" — another admin must exist in the organization to inherit their agents.`,
    );
  }
  await db.update(agents).set({ managerId: fallback.id }).where(eq(agents.managerId, id));

  // Mark the member's human agent as deleted
  await db.update(agents).set({ status: "deleted", name: null }).where(eq(agents.uuid, member.agentId));

  // Delete member record
  await db.delete(members).where(eq(members.id, id));

  // Note: user record is kept (for multi-org future — user may belong to other orgs)
}

/** Throw if this is the last admin in the organization. */
async function assertNotLastAdmin(db: Database, orgId: string, excludeMemberId: string): Promise<void> {
  const [otherAdmin] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, orgId), eq(members.role, "admin"), ne(members.id, excludeMemberId)))
    .limit(1);

  if (!otherAdmin) {
    throw new BadRequestError("Cannot remove the last admin from the organization");
  }
}
