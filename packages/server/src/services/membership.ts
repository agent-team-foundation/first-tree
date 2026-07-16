import { randomBytes } from "node:crypto";
import { AGENT_STATUSES, AGENT_TYPES } from "@first-tree/shared";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import { forceDisconnect } from "./connection-manager.js";
import { suspendGitlabLinksForMembership } from "./gitlab-identities.js";
import * as presenceService from "./presence.js";
import { recomputeWatchersForAgent, recomputeWatchersForMember } from "./watcher.js";

/**
 * Helpers used by the SaaS onboarding flow to create / reuse / leave a
 * member's slot in an organization. Lives in its own module (not member.ts)
 * because member.ts is the admin-CRUD surface — these helpers are
 * self-service and don't share its admin invariants (e.g. "last admin can't
 * be demoted" doesn't apply to "last admin leaves").
 */

export const MEMBER_STATUSES = {
  ACTIVE: "active",
  LEFT: "left",
  REMOVED: "removed",
} as const;

export type MemberStatus = (typeof MEMBER_STATUSES)[keyof typeof MEMBER_STATUSES];

// biome-ignore lint/suspicious/noExplicitAny: needed for cross-schema compatibility with transaction clients.
type DbLike = PgDatabase<PgQueryResultHKT, any, any>;

type CreateMembershipForUser = {
  userId: string;
  organizationId: string;
  role: "admin" | "member";
  /** Display name for the human agent — falls back to user's displayName. */
  displayName: string;
  /** Slugged username; used as the human agent's `name`. */
  username: string;
};

/** Insert (or reactivate) a `members` row for `userId` in `organizationId`. */
export async function ensureMembership(db: Database, data: CreateMembershipForUser) {
  const [existing] = await db
    .select()
    .from(members)
    .where(and(eq(members.userId, data.userId), eq(members.organizationId, data.organizationId)))
    .limit(1);

  if (existing) {
    if (existing.status === MEMBER_STATUSES.LEFT) {
      // Re-activate the prior soft-deleted row and its human-agent mirror.
      //
      // Rejoin starts a FRESH onboarding lifecycle for this membership: clear
      // the prior suppress/completion stamps so the auto-entry gate treats
      // the rejoined member as first-need again. A stale suppress stamp
      // would otherwise hide setup for what is effectively a newly joined
      // team — the exact failure mode the membership-scoped gate exists to
      // prevent.
      await db.transaction(async (tx) => {
        await reactivateMembership(tx, existing, {
          displayName: data.displayName,
          username: data.username,
          resetOnboarding: true,
        });
      });
      return {
        ...existing,
        status: MEMBER_STATUSES.ACTIVE,
        onboardingSuppressedAt: null,
        onboardingSuppressedReason: null,
        onboardingCompletedAt: null,
      };
    }
    if (existing.status === MEMBER_STATUSES.REMOVED) {
      throw new ConflictError(
        `Membership for user "${data.userId}" was removed by an admin and must be restored by an admin.`,
      );
    }
    return existing;
  }

  return db.transaction(async (tx) => {
    const memberId = uuidv7();
    const agentName = sanitizeAgentName(data.username);
    const inboxId = `inbox_${uuidv7()}`;
    const agentUuid = uuidv7();

    await tx.insert(agents).values({
      uuid: agentUuid,
      name: agentName,
      organizationId: data.organizationId,
      type: "human",
      displayName: data.displayName,
      inboxId,
      source: "oauth",
      visibility: "organization",
      managerId: memberId,
    });

    const [row] = await tx
      .insert(members)
      .values({
        id: memberId,
        userId: data.userId,
        organizationId: data.organizationId,
        agentId: agentUuid,
        role: data.role,
        status: MEMBER_STATUSES.ACTIVE,
      })
      .returning();
    if (!row) throw new Error("Unexpected: INSERT RETURNING produced no row");
    return row;
  });
}

function sanitizeAgentName(login: string): string {
  return (
    login
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "user"
  );
}

type ExistingMembershipForLifecycle = {
  id: string;
  agentId: string;
  organizationId: string;
  status: string;
};

type ReactivateMembershipOptions = {
  displayName: string;
  username: string;
  role?: "admin" | "member";
  resetOnboarding?: boolean;
};

/**
 * Restore an inactive member and its 1:1 human-agent mirror. The member row is
 * preserved so historical chats, authorship, and ownership references keep the
 * same stable ids across leave/rejoin and admin restore.
 */
export async function reactivateMembership(
  db: DbLike,
  existing: ExistingMembershipForLifecycle,
  options: ReactivateMembershipOptions,
): Promise<void> {
  const memberUpdate = {
    ...(options.role ? { role: options.role } : {}),
    status: MEMBER_STATUSES.ACTIVE,
    ...(options.resetOnboarding
      ? {
          onboardingSuppressedAt: null,
          onboardingSuppressedReason: null,
          onboardingCompletedAt: null,
        }
      : {}),
  };
  await db.update(members).set(memberUpdate).where(eq(members.id, existing.id));

  const [mirror] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.uuid, existing.agentId))
    .limit(1);
  if (mirror?.name === null) {
    const restoredName = await resolveRestoredAgentName(db, existing, options.username);
    await db
      .update(agents)
      .set({
        status: AGENT_STATUSES.ACTIVE,
        displayName: options.displayName,
        name: restoredName,
        clientId: null,
        updatedAt: new Date(),
      })
      .where(eq(agents.uuid, existing.agentId));
  } else {
    await db
      .update(agents)
      .set({
        status: AGENT_STATUSES.ACTIVE,
        displayName: options.displayName,
        clientId: null,
        updatedAt: new Date(),
      })
      .where(eq(agents.uuid, existing.agentId));
  }

  await recomputeWatchersForMember(db, existing.id);
}

async function resolveRestoredAgentName(
  db: DbLike,
  existing: Pick<ExistingMembershipForLifecycle, "agentId" | "organizationId">,
  username: string,
): Promise<string> {
  const base = sanitizeAgentName(username);
  const suffixes = ["", existing.agentId.slice(0, 8), randomBytes(2).toString("hex")];
  for (const suffix of suffixes) {
    const candidate = suffix ? appendAgentNameSuffix(base, suffix) : base;
    const [collision] = await db
      .select({ uuid: agents.uuid })
      .from(agents)
      .where(
        and(
          eq(agents.organizationId, existing.organizationId),
          eq(agents.name, candidate),
          ne(agents.uuid, existing.agentId),
        ),
      )
      .limit(1);
    if (!collision) return candidate;
  }
  return appendAgentNameSuffix(base, randomBytes(4).toString("hex"));
}

function appendAgentNameSuffix(base: string, suffix: string): string {
  const maxNameLength = 64;
  const roomForBase = maxNameLength - suffix.length - 1;
  return `${base.slice(0, Math.max(1, roomForBase))}-${suffix}`;
}

/**
 * Move a membership out of the active roster while preserving its identity.
 * The human mirror becomes suspended, not deleted, so names and historical
 * attribution remain intact and a future explicit restore can reactivate the
 * same member+agent pair.
 *
 * The non-human agents this member manages are reassigned to a fallback active
 * admin and unpinned (`clientId = null`), mirroring the admin removal path in
 * `member.ts::deleteMember`. Without this, a self-service leave would strand
 * those agents `active` and pinned to the user's client, and `retireClient`'s
 * guard would later deadlock the user out of retiring their own computer
 * (issue #1353). The whole reassignment + lifecycle flip runs in one
 * transaction so a concurrent `createAgent`/`deleteMember` cannot interleave;
 * the runtime force-disconnect/unbind happens after commit.
 *
 * Scope is deliberately narrow: leave is blocked only when the member actually
 * manages non-human agents AND no other active admin exists to inherit them.
 * A member with no managed non-human agents may still leave even as the sole
 * admin — the broader "an org should keep an admin" concern is a separate org
 * lifecycle question this function does not take on.
 */
export async function deactivateMembership(
  db: Database,
  memberId: string,
  status: typeof MEMBER_STATUSES.LEFT | typeof MEMBER_STATUSES.REMOVED,
) {
  const { existing, transferredAgentIds } = await db.transaction(async (tx) => {
    // Read the org up-front (unlocked) so the admin lock below is scoped to it,
    // then lock the active-admin set in a deterministic order — identical lock
    // ordering to `deleteMember` so concurrent removals/leaves in the same org
    // serialize instead of deadlocking on the admin selection.
    const [targetRef] = await tx
      .select({ organizationId: members.organizationId })
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1);
    if (!targetRef) throw new NotFoundError(`Membership "${memberId}" not found`);

    const activeAdmins = await tx
      .select({ id: members.id })
      .from(members)
      .where(
        and(
          eq(members.organizationId, targetRef.organizationId),
          eq(members.role, "admin"),
          eq(members.status, MEMBER_STATUSES.ACTIVE),
        ),
      )
      .orderBy(asc(members.id))
      .for("update");

    const [existing] = await tx.select().from(members).where(eq(members.id, memberId)).for("update").limit(1);
    if (!existing) throw new NotFoundError(`Membership "${memberId}" not found`);
    if (existing.status !== MEMBER_STATUSES.ACTIVE && existing.status !== status) {
      throw new ConflictError(`Membership "${memberId}" is not active`);
    }

    // Reassign the member's non-human agents to a sibling admin and unpin them.
    // The human mirror (a HUMAN-typed self-managed agent) is excluded here and
    // suspended separately below. Scope is strictly `managerId = memberId` and
    // non-deleted: agents the same user still manages via other active
    // memberships keep their `clientId` (a client shared across the user's orgs
    // may still correctly hold pinned agents the user can reach), and deleted
    // tombstones are skipped entirely — `retireClient` already treats them as
    // non-blocking, and counting them would trap a sole admin who followed the
    // 409's "delete these agents first" guidance: the tombstone keeps its
    // `managerId`, so an unfiltered count would still see managed agents with
    // no fallback admin and 409 forever. Suspended agents still count — they
    // remain live, manageable, and may still carry a `clientId`.
    const managedFilter = and(
      eq(agents.managerId, memberId),
      ne(agents.type, AGENT_TYPES.HUMAN),
      ne(agents.status, AGENT_STATUSES.DELETED),
    );
    const managed = await tx.select({ uuid: agents.uuid }).from(agents).where(managedFilter);

    let transferredAgentIds: string[] = [];
    if (managed.length > 0) {
      const fallback = activeAdmins.find((admin) => admin.id !== memberId);
      if (!fallback) {
        throw new ConflictError(
          `Cannot leave the organization — you manage ${managed.length} agent(s) here and there is no other ` +
            "active admin to take them over. Add another admin, or delete these agents, before leaving.",
        );
      }
      const transferred = await tx
        .update(agents)
        .set({ managerId: fallback.id, clientId: null, updatedAt: new Date() })
        .where(managedFilter)
        .returning({ uuid: agents.uuid });
      for (const { uuid } of transferred) {
        await recomputeWatchersForAgent(tx, uuid);
      }
      transferredAgentIds = transferred.map((agent) => agent.uuid);
    }

    if (existing.status !== status) {
      await tx.update(members).set({ status }).where(eq(members.id, memberId));
    }
    await suspendGitlabLinksForMembership(
      tx as unknown as Database,
      memberId,
      status === MEMBER_STATUSES.LEFT ? "member_left" : "member_removed",
      status === MEMBER_STATUSES.LEFT ? memberId : null,
    );
    await tx
      .update(agents)
      .set({ status: AGENT_STATUSES.SUSPENDED, clientId: null, updatedAt: new Date() })
      .where(eq(agents.uuid, existing.agentId));
    await recomputeWatchersForMember(tx, memberId);
    return { existing, transferredAgentIds };
  });

  // After commit: drop any live runtime presence for the reassigned agents so
  // they re-evaluate binding under their new manager instead of the departed
  // member's client.
  for (const agentId of transferredAgentIds) {
    forceDisconnect(agentId, "member_left");
    await presenceService.unbindAgent(db, agentId);
  }

  return { ...existing, status };
}

export type MembershipMirrorRepairResult = {
  activeMirrorsRepaired: number;
  inactiveMirrorsRepaired: number;
};

/**
 * Idempotent startup repair for rows produced before membership removal used
 * the suspended-mirror model. Active members must have an active, named human
 * mirror; inactive memberships keep the mirror named but suspended.
 */
export async function repairMembershipHumanMirrors(db: Database): Promise<MembershipMirrorRepairResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        memberId: members.id,
        memberStatus: members.status,
        agentId: members.agentId,
        organizationId: members.organizationId,
        username: users.username,
        mirrorType: agents.type,
        mirrorStatus: agents.status,
        mirrorName: agents.name,
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .innerJoin(agents, eq(agents.uuid, members.agentId))
      .for("update");

    let activeMirrorsRepaired = 0;
    let inactiveMirrorsRepaired = 0;
    for (const row of rows) {
      const desiredStatus =
        row.memberStatus === MEMBER_STATUSES.ACTIVE ? AGENT_STATUSES.ACTIVE : AGENT_STATUSES.SUSPENDED;
      const needsRepair =
        row.mirrorType !== AGENT_TYPES.HUMAN || row.mirrorStatus !== desiredStatus || row.mirrorName === null;
      if (!needsRepair) continue;

      const restoredName =
        row.mirrorName ??
        (await resolveRestoredAgentName(
          tx,
          { agentId: row.agentId, organizationId: row.organizationId },
          row.username,
        ));
      await tx
        .update(agents)
        .set({
          type: AGENT_TYPES.HUMAN,
          status: desiredStatus,
          name: restoredName,
          clientId: null,
          updatedAt: new Date(),
        })
        .where(eq(agents.uuid, row.agentId));

      if (row.memberStatus === MEMBER_STATUSES.ACTIVE) activeMirrorsRepaired += 1;
      else inactiveMirrorsRepaired += 1;
    }

    return { activeMirrorsRepaired, inactiveMirrorsRepaired };
  });
}

type CreatePersonalTeamInput = {
  userId: string;
  /** Final unique username, used as the seed for the team slug and human agent name. */
  username: string;
  /** Display label for the personal team (e.g. `${login}'s team`). */
  teamDisplayName: string;
  /** Display label for the user's human agent. */
  userDisplayName: string;
};

/**
 * Create a fresh default team org for a brand-new user, plus the matching
 * admin membership + 1:1 human agent. Slug strategy:
 *
 *   - First try: `${username}` (lowercased, sanitized)
 *   - On collision: append a 4-char hex disambiguator
 *
 * Default team display name is `${displayName}'s team` (set by the caller — see
 * first-tree-context:agent-hub/onboarding.md (was §5.5 in source design)). Reads as "this is a collective
 * space" from day one so a later teammate-invite doesn't surface a label
 * that looks like a private sandbox. Users can rename via Step 1 of the
 * onboarding flow or Settings.
 */
export async function createPersonalTeam(db: Database, input: CreatePersonalTeamInput) {
  const baseSlug = sanitizeOrgSlug(input.username);
  const displayName = input.teamDisplayName;

  const orgId = uuidv7();
  const slug = await insertOrgWithSlugRetry(db, orgId, baseSlug, displayName);

  const member = await ensureMembership(db, {
    userId: input.userId,
    organizationId: orgId,
    role: "admin",
    displayName: input.userDisplayName,
    username: input.username,
  });

  return { organizationId: orgId, slug, displayName, memberId: member.id };
}

function sanitizeOrgSlug(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "team"
  );
}

/**
 * Attempt INSERT into `organizations` with `base` slug, retrying with a
 * disambiguator when the unique slug is already occupied. `ON CONFLICT DO
 * NOTHING` is intentional: this helper is also called inside the user-row
 * transaction used by OAuth bootstrap, where catching a 23505 would leave
 * the transaction aborted before the retry can run.
 */
async function insertOrgWithSlugRetry(db: Database, orgId: string, base: string, displayName: string): Promise<string> {
  const [existing] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, base))
    .limit(1);
  let candidate = existing ? `${base}-${randomBytes(2).toString("hex")}` : base;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const [inserted] = await db
      .insert(organizations)
      .values({ id: orgId, name: candidate, displayName })
      .onConflictDoNothing({ target: organizations.name })
      .returning({ name: organizations.name });
    if (inserted) return inserted.name;
    candidate = `${base}-${randomBytes(2).toString("hex")}`;
  }

  // Pathological collision storm — random suffix always wins.
  candidate = `${base}-${uuidv7().slice(0, 12)}`;
  const [inserted] = await db
    .insert(organizations)
    .values({ id: orgId, name: candidate, displayName })
    .onConflictDoNothing({ target: organizations.name })
    .returning({ name: organizations.name });
  if (inserted) return inserted.name;

  // UUID fragments make this practically unreachable; retain a clear error
  // rather than silently returning a slug whose organization was not created.
  throw new Error("Unable to allocate a unique organization slug");
}

/** List ACTIVE memberships (omit soft-deleted "left"/"removed") for a user. */
export async function listActiveMemberships(db: Database, userId: string) {
  const rows = await db
    .select({
      memberId: members.id,
      organizationId: members.organizationId,
      role: members.role,
      agentId: members.agentId,
      onboardingSuppressedAt: members.onboardingSuppressedAt,
      onboardingSuppressedReason: members.onboardingSuppressedReason,
      onboardingCompletedAt: members.onboardingCompletedAt,
      orgName: organizations.name,
      orgDisplayName: organizations.displayName,
      createdAt: members.createdAt,
    })
    .from(members)
    .innerJoin(organizations, eq(members.organizationId, organizations.id))
    .where(and(eq(members.userId, userId), eq(members.status, MEMBER_STATUSES.ACTIVE)))
    .orderBy(desc(members.createdAt));
  return rows;
}

/**
 * Count ACTIVE members per org, restricted to the given org IDs. Returns a
 * Map keyed by `organizationId`; orgs absent from the result simply have
 * zero active members (shouldn't happen in practice — the caller always
 * passes orgs the user is a member of — but the Map shape lets callers do
 * `counts.get(orgId) ?? 0` defensively). Used by `/me` to surface
 * `orgHasOtherMembers` per membership without N+1 queries.
 */
export async function countActiveMembersByOrgs(db: Database, organizationIds: string[]): Promise<Map<string, number>> {
  if (organizationIds.length === 0) return new Map();
  const rows = await db
    .select({
      organizationId: members.organizationId,
      count: sql<number>`count(*)::int`,
    })
    .from(members)
    .where(and(inArray(members.organizationId, organizationIds), eq(members.status, MEMBER_STATUSES.ACTIVE)))
    .groupBy(members.organizationId);
  return new Map(rows.map((r) => [r.organizationId, r.count]));
}

/**
 * Pick the most recently joined active membership — used after OAuth login
 * when the user already has at least one team but no `next` was specified.
 */
export async function pickPrimaryMembership(db: Database, userId: string) {
  const rows = await listActiveMemberships(db, userId);
  return rows[0] ?? null;
}

/**
 * Look up a user's ACTIVE membership in a specific org. Returns null when
 * the user isn't a member there (or their row is inactive).
 *
 * Used by the OAuth callback to re-check that a `targetOrganizationId`
 * carried in the signed state still names an org the user can administer
 * before binding a GitHub App installation to it (codex P1-3) — the state
 * JWT lives ~10min, long enough for a membership to be revoked.
 */
export async function findActiveMembership(db: Database, userId: string, organizationId: string) {
  const [row] = await db
    .select({ memberId: members.id, role: members.role })
    .from(members)
    .where(
      and(
        eq(members.userId, userId),
        eq(members.organizationId, organizationId),
        eq(members.status, MEMBER_STATUSES.ACTIVE),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Mark `members.status='left'` for the given member. v1 simplification:
 * no "must transfer admin" check — the proposal accepts the trade-off
 * (last admin allowed to leave, leaves an orphan team) and the cleanup is
 * a v2 sweep job.
 */
/**
 * Soft-leave an organization. Flips the member's row to `status='left'`
 * and reconciles watcher rows: `recomputeChatWatchers`'s active-member
 * predicate now drops every watcher anchored to this member, removing
 * the chats from their `/me/chats` watching list.
 */
export async function leaveOrganization(db: Database, memberId: string) {
  return deactivateMembership(db, memberId, MEMBER_STATUSES.LEFT);
}

/**
 * Self-service "create another team" (operator clicks "Create team" in the
 * org switcher). Caller is the new team's admin. Slug uniqueness is
 * enforced by the underlying organizations.name UNIQUE constraint.
 */
export async function selfCreateOrganization(
  db: Database,
  data: { userId: string; userDisplayName: string; username: string; name: string; displayName: string },
) {
  // Cheap pre-check so the API returns 409 rather than letting the FK
  // explode further down. Race window with concurrent creates is fine —
  // the unique constraint is the authoritative gate.
  const [collision] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, data.name))
    .limit(1);
  if (collision) {
    throw new ConflictError(`Organization "${data.name}" already exists`);
  }

  if (data.name === "default") {
    throw new BadRequestError('"default" is a reserved organization name');
  }

  const orgId = uuidv7();
  await db.insert(organizations).values({ id: orgId, name: data.name, displayName: data.displayName });
  const member = await ensureMembership(db, {
    userId: data.userId,
    organizationId: orgId,
    role: "admin",
    displayName: data.userDisplayName,
    username: data.username,
  });
  return { organizationId: orgId, memberId: member.id, name: data.name, displayName: data.displayName };
}
