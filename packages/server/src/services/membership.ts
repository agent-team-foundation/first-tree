import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import { recomputeWatchersForMember } from "./watcher.js";

/**
 * Helpers used by the SaaS onboarding flow to create / reuse / leave a
 * member's slot in an organization. Lives in its own module (not member.ts)
 * because member.ts is the admin-CRUD surface — these helpers are
 * self-service and don't share its admin invariants (e.g. "last admin can't
 * be demoted" doesn't apply to "last admin leaves").
 */

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
    if (existing.status === "left") {
      // Re-activate the prior soft-deleted row. The human agent associated
      // with it may be in any state — leave it alone; it gets refreshed
      // implicitly when the member starts using the team again.
      await db.update(members).set({ status: "active" }).where(eq(members.id, existing.id));
      // Watcher rows: re-activated member regains visibility into chats
      // where their managed non-human agents speak. recompute restores
      // the rows that were dropped on the prior `left` flip.
      await recomputeWatchersForMember(db, existing.id);
      return { ...existing, status: "active" as const };
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
        status: "active",
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

type CreatePersonalTeamInput = {
  userId: string;
  /** GitHub login slug, used as the seed for the team slug. */
  loginSeed: string;
  /** Display label for the personal team (e.g. `${login}'s team`). */
  teamDisplayName: string;
  /** Display label for the user's human agent. */
  userDisplayName: string;
};

/**
 * Create a fresh default team org for a brand-new user, plus the matching
 * admin membership + 1:1 human agent. Slug strategy:
 *
 *   - First try: `${login}` (lowercased, sanitized)
 *   - On collision: append a 4-char hex disambiguator
 *
 * Default team display name is `${login}'s team` (set by the caller — see
 * docs/new-user-onboarding-design.md §5.5). Reads as "this is a collective
 * space" from day one so a later teammate-invite doesn't surface a label
 * that looks like a private sandbox. Users can rename via Step 1 of the
 * onboarding flow or Settings.
 */
export async function createPersonalTeam(db: Database, input: CreatePersonalTeamInput) {
  const baseSlug = sanitizeOrgSlug(input.loginSeed);
  const displayName = input.teamDisplayName;

  const orgId = uuidv7();
  const slug = await insertOrgWithSlugRetry(db, orgId, baseSlug, displayName);

  const member = await ensureMembership(db, {
    userId: input.userId,
    organizationId: orgId,
    role: "admin",
    displayName: input.userDisplayName,
    username: input.loginSeed,
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

/** Postgres `unique_violation` SQLSTATE — `organizations.name` UNIQUE tripping. */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Attempt INSERT into `organizations` with `base` slug, retrying with a
 * disambiguator on UNIQUE constraint violations. Two concurrent OAuth
 * sign-ins for the same GitHub `login` would race here without retry —
 * pre-check `SELECT` followed by `INSERT` has a TOCTOU window the unique
 * constraint catches but the catch path needs to exist. Returns the slug
 * actually used.
 */
async function insertOrgWithSlugRetry(db: Database, orgId: string, base: string, displayName: string): Promise<string> {
  const [existing] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, base))
    .limit(1);
  let candidate = existing ? `${base}-${randomBytes(2).toString("hex")}` : base;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await db.insert(organizations).values({ id: orgId, name: candidate, displayName });
      return candidate;
    } catch (err) {
      const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (code !== PG_UNIQUE_VIOLATION) throw err;
      candidate = `${base}-${randomBytes(2).toString("hex")}`;
    }
  }

  // Pathological collision storm — random suffix always wins.
  candidate = `${base}-${uuidv7().slice(0, 12)}`;
  await db.insert(organizations).values({ id: orgId, name: candidate, displayName });
  return candidate;
}

/** List ACTIVE memberships (omit soft-deleted "left") for a user. */
export async function listActiveMemberships(db: Database, userId: string) {
  const rows = await db
    .select({
      memberId: members.id,
      organizationId: members.organizationId,
      role: members.role,
      agentId: members.agentId,
      orgName: organizations.name,
      orgDisplayName: organizations.displayName,
      createdAt: members.createdAt,
    })
    .from(members)
    .innerJoin(organizations, eq(members.organizationId, organizations.id))
    .where(and(eq(members.userId, userId), eq(members.status, "active")))
    .orderBy(desc(members.createdAt));
  return rows;
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
 * the user isn't a member there (or their row is soft-deleted `left`).
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
    .where(and(eq(members.userId, userId), eq(members.organizationId, organizationId), eq(members.status, "active")))
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
  const [existing] = await db.select().from(members).where(eq(members.id, memberId)).limit(1);
  if (!existing) throw new NotFoundError(`Membership "${memberId}" not found`);
  if (existing.status === "left") return existing;
  await db.update(members).set({ status: "left" }).where(eq(members.id, memberId));
  // Watcher rows anchored to this member's managed non-human agents drop
  // off — they pivot through the now-inactive member, so the active-member
  // predicate filters them out on the next recompute.
  await recomputeWatchersForMember(db, memberId);
  return { ...existing, status: "left" as const };
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
