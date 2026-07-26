import { randomBytes } from "node:crypto";
import { AGENT_STATUSES, AGENT_TYPES, type CreateMember, type UpdateMember } from "@first-tree/shared";
import bcrypt from "bcrypt";
import { and, asc, desc, eq, inArray, max, ne } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { users } from "../db/schema/users.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import { createAgent } from "./agent.js";
import { forceDisconnect } from "./connection-manager.js";
import { suspendGitlabLinksForMembership } from "./gitlab-identities.js";
import { MEMBER_STATUSES, reactivateMembership, syncUserDisplayName } from "./membership.js";
import * as presenceService from "./presence.js";
import { recomputeWatchersForAgent, recomputeWatchersForMember } from "./watcher.js";

const SALT_ROUNDS = 10;

/**
 * Derive each member's "last active" timestamp from the most recent message
 * sent by their human agent — `MAX(messages.created_at)` grouped by sender.
 * Intentionally column-free (no `users.last_active_at`); this is口径 B
 * ("most recent message"). Returns a Map keyed by agentId → ISO string.
 *
 * Cost note: `messages` has no `sender_id` index, so this is a grouped scan.
 * Acceptable for the occasionally-loaded member list at current scale; a
 * `(sender_id, created_at)` index would be the lever if it ever gets hot.
 */
async function lastActiveByAgent(db: Database, agentIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (agentIds.length === 0) return result;
  const rows = await db
    .select({ senderId: messages.senderId, last: max(messages.createdAt) })
    .from(messages)
    .where(inArray(messages.senderId, agentIds))
    .groupBy(messages.senderId);
  for (const r of rows) {
    if (r.last) result.set(r.senderId, r.last.toISOString());
  }
  return result;
}

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
      if (existingMember.status === MEMBER_STATUSES.ACTIVE) {
        throw new ConflictError(`User "${data.username}" is already a member of this organization`);
      }
      if (existingMember.status !== MEMBER_STATUSES.LEFT && existingMember.status !== MEMBER_STATUSES.REMOVED) {
        throw new ConflictError(`User "${data.username}" has an unsupported membership status`);
      }

      await db.transaction(async (tx) => {
        await reactivateMembership(tx, existingMember, {
          displayName: data.displayName,
          username: data.username,
          role: data.role ?? "member",
          resetOnboarding: true,
        });
      });

      const member = await getMember(db, existingMember.id);
      return {
        ...member,
        username: data.username,
        displayName: data.displayName,
        notice: "Existing user — use their current password to log in",
      };
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

    return syncUserDisplayName(tx, userId, data.displayName, async () => {
      // Another membership lifecycle may have committed while the initial
      // pre-check waited on this user's identity lock. Re-check under that
      // lock before touching the unique (user, organization) slot.
      if (existingUser) {
        const [membershipCollision] = await tx
          .select({ id: members.id })
          .from(members)
          .where(and(eq(members.userId, userId), eq(members.organizationId, orgId)))
          .limit(1);
        if (membershipCollision) {
          throw new ConflictError(`User "${data.username}" is already a member of this organization`);
        }
      }

      // Compute the member id up-front so the human mirror self-manages.
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
        // Freshly created — no messages yet, so no derived activity.
        lastActiveAt: null,
        username: data.username,
        displayName: data.displayName,
        avatarUrl: existingUser?.avatarUrl ?? null,
        // Only return password for new users
        ...(password ? { password } : { notice: "Existing user — use their current password to log in" }),
      };
    });
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
      status: members.status,
      createdAt: members.createdAt,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(and(eq(members.organizationId, orgId), eq(members.status, MEMBER_STATUSES.ACTIVE)))
    .orderBy(desc(members.createdAt));

  const lastActive = await lastActiveByAgent(
    db,
    rows.map((r) => r.agentId),
  );
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    lastActiveAt: lastActive.get(r.agentId) ?? null,
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
      status: members.status,
      createdAt: members.createdAt,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(eq(members.id, id))
    .limit(1);

  if (!row) throw new NotFoundError(`Member "${id}" not found`);
  const lastActive = await lastActiveByAgent(db, [row.agentId]);
  return { ...row, createdAt: row.createdAt.toISOString(), lastActiveAt: lastActive.get(row.agentId) ?? null };
}

export async function updateMember(db: Database, id: string, data: UpdateMember, callerOrgId?: string) {
  const current = await getMember(db, id);
  // A cross-org admin should never be able to mutate a member in another
  // tenant. The route layer supplies its own org id; without a match we
  // 404 to avoid leaking that the member exists.
  if (callerOrgId && current.organizationId !== callerOrgId) {
    throw new NotFoundError(`Member "${id}" not found`);
  }
  if (current.status !== MEMBER_STATUSES.ACTIVE) {
    throw new NotFoundError(`Member "${id}" not found`);
  }

  if (data.role === undefined && data.displayName === undefined) {
    return current;
  }

  // Prevent demoting the last admin — if the caller is turning the final
  // admin into a member, the org would be locked out of admin operations.
  if (data.role === "member" && current.role === "admin") {
    await assertNotLastAdmin(db, current.organizationId, id);
  }

  await db.transaction(async (tx) => {
    const updateRole = async () => {
      if (data.role !== undefined && data.role !== current.role) {
        await tx.update(members).set({ role: data.role }).where(eq(members.id, id));
      }
    };
    // displayName is user-global: members have no display_name column and
    // listMembers reads users.display_name. Keep every membership-scoped
    // human agent mirror aligned so chat detail never disagrees with the
    // member/AuthProvider identity after an admin rename in any organization.
    if (data.displayName !== undefined) {
      await syncUserDisplayName(tx, current.userId, data.displayName, updateRole);
    } else {
      await updateRole();
    }
  });

  return getMember(db, id);
}

/**
 * Self-service display-name edit. Updates the authoritative `users.display_name`
 * and mirrors it onto every human agent backing this user's memberships (the
 * member list + agent-detail views both read from these, so they must not
 * drift). Role is never touched here — self-promotion is impossible by
 * construction. Returns the updated `{ id, displayName }`.
 */
export async function updateOwnProfile(db: Database, userId: string, displayName: string) {
  await db.transaction(async (tx) => {
    await syncUserDisplayName(tx, userId, displayName);
  });
  return { id: userId, displayName };
}

export async function deleteMember(db: Database, id: string, callerOrgId: string) {
  const transferredAgentIds = await db.transaction(async (tx) => {
    const [targetRef] = await tx
      .select({ organizationId: members.organizationId })
      .from(members)
      .where(eq(members.id, id))
      .limit(1);
    // A cross-org admin should never be able to delete a member in another
    // tenant. Return 404 to avoid leaking that the member exists.
    if (!targetRef || targetRef.organizationId !== callerOrgId) {
      throw new NotFoundError(`Member "${id}" not found`);
    }

    const activeAdmins = await tx
      .select({ id: members.id })
      .from(members)
      .where(
        and(
          eq(members.organizationId, callerOrgId),
          eq(members.role, "admin"),
          eq(members.status, MEMBER_STATUSES.ACTIVE),
        ),
      )
      .orderBy(asc(members.id))
      .for("update");

    const [member] = await tx
      .select({
        id: members.id,
        organizationId: members.organizationId,
        role: members.role,
        status: members.status,
        agentId: members.agentId,
      })
      .from(members)
      .where(eq(members.id, id))
      .for("update")
      .limit(1);
    if (!member || member.organizationId !== callerOrgId || member.status !== MEMBER_STATUSES.ACTIVE) {
      throw new NotFoundError(`Member "${id}" not found`);
    }

    // Prevent deleting the last admin. The active-admin rows are locked in a
    // deterministic order above, so concurrent admin removals serialize before
    // this check and fallback selection.
    const fallback = activeAdmins.find((admin) => admin.id !== id);
    if (member.role === "admin" && !fallback) {
      throw new BadRequestError("Cannot remove the last admin from the organization");
    }
    if (!fallback) {
      throw new ConflictError(
        `Cannot delete member "${id}" — another admin must exist in the organization to inherit their agents.`,
      );
    }

    // Reassign every non-human agent managed by this member to another active
    // admin in the org. The member's human mirror stays attached to the member
    // row and is suspended by the membership lifecycle update below.
    // managerId is NOT NULL after the unified-user-token milestone, so we can
    // never clear it — a sibling admin takes over.
    const transferred = await tx
      .update(agents)
      .set({ managerId: fallback.id, clientId: null, updatedAt: new Date() })
      .where(and(eq(agents.managerId, id), ne(agents.type, AGENT_TYPES.HUMAN)))
      .returning({ uuid: agents.uuid });

    for (const { uuid } of transferred) {
      await recomputeWatchersForAgent(tx, uuid);
    }

    const [deactivated] = await tx
      .update(members)
      .set({ status: MEMBER_STATUSES.REMOVED })
      .where(and(eq(members.id, id), eq(members.status, MEMBER_STATUSES.ACTIVE)))
      .returning({ id: members.id });
    if (!deactivated) {
      throw new ConflictError(`Membership "${id}" is not active`);
    }
    await suspendGitlabLinksForMembership(tx as unknown as Database, id);
    await tx
      .update(agents)
      .set({ status: AGENT_STATUSES.SUSPENDED, clientId: null, updatedAt: new Date() })
      .where(eq(agents.uuid, member.agentId));
    await recomputeWatchersForMember(tx, id);
    return transferred.map((agent) => agent.uuid);
  });

  for (const agentId of transferredAgentIds) {
    forceDisconnect(agentId, "member_removed");
    await presenceService.unbindAgent(db, agentId);
  }

  // Note: user record is kept (for multi-org future — user may belong to other orgs).
}

/** Throw if this is the last admin in the organization. */
async function assertNotLastAdmin(db: Database, orgId: string, excludeMemberId: string): Promise<void> {
  const [otherAdmin] = await db
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.organizationId, orgId),
        eq(members.role, "admin"),
        eq(members.status, MEMBER_STATUSES.ACTIVE),
        ne(members.id, excludeMemberId),
      ),
    )
    .limit(1);

  if (!otherAdmin) {
    throw new BadRequestError("Cannot remove the last admin from the organization");
  }
}
