import type { CreateWorkspaceRequest, WorkspaceListItem } from "@agent-team-foundation/first-tree-hub-shared";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";
import { createAgent } from "./agent.js";
import { generateInviteToken } from "./organization.js";

/**
 * Workspace membership operations bound to a specific authenticated user.
 *
 * These are SaaS-flow-specific equivalents of `services/member.ts::createMember`
 * (which is the legacy admin-API path that creates a member from an invite-by-
 * username). The split keeps the legacy path intact while the new path:
 *   * trusts an already-authenticated `userId` (no password generation)
 *   * exposes "create my own workspace" + "join via invite token" as two
 *     distinct operations the SaaS UI calls directly
 *   * always materialises a `members` + 1:1 human `agents` row in one tx,
 *     matching the constraints established in the unified-user-token
 *     milestone (members.agent_id is NOT NULL).
 *
 * See docs/saas-onboarding-journey.md §4.3 (Join) and §4.4 (Create).
 */

/**
 * Build the human-agent slug for a fresh membership. Always `me-<suffix>`
 * to satisfy `AGENT_NAME_REGEX` (`^[a-z0-9][a-z0-9_-]{0,63}$`) regardless of
 * the user's display name (which can be CJK, emoji, etc), and to avoid
 * collisions on the `(organizationId, name)` unique constraint when a join
 * lands in an org that already has a peer with the same vanity name. The
 * agent's friendly label still comes from `users.display_name`.
 */
function generateMemberAgentName(memberId: string): string {
  return `me-${memberId.slice(-8)}`;
}

/** Workspaces this user belongs to, newest first. */
export async function listMyWorkspaces(db: Database, userId: string): Promise<WorkspaceListItem[]> {
  const rows = await db
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      organizationDisplayName: organizations.displayName,
      memberId: members.id,
      role: members.role,
      createdAt: members.createdAt,
    })
    .from(members)
    .innerJoin(organizations, eq(members.organizationId, organizations.id))
    .where(eq(members.userId, userId))
    .orderBy(desc(members.createdAt));

  return rows.map((r) => ({
    organizationId: r.organizationId,
    organizationName: r.organizationName,
    organizationDisplayName: r.organizationDisplayName,
    memberId: r.memberId,
    // role is stored as plain text — narrow to the union the API contract
    // promises. Anything outside admin/member is a data-integrity bug, not
    // something we'd want to silently round-trip.
    role: r.role === "admin" ? "admin" : "member",
  }));
}

/**
 * Create a brand-new workspace owned by `userId`. Atomic:
 *   1. organizations row (with auto-generated invite_token)
 *   2. agents row — the user's 1:1 human agent in this workspace
 *   3. members row binding (user, org) → agent, role=admin
 *
 * Three different unique constraints can fire (slug, agent name within org,
 * member-per-org). We map each by inspecting `constraint_name` from the
 * postgres-js error so the user sees the right message — defaulting to a
 * generic "retry" rather than misattributing every collision to the slug.
 */
export async function createWorkspaceForUser(
  db: Database,
  userId: string,
  data: CreateWorkspaceRequest,
): Promise<{ workspaceId: string; memberId: string; role: "admin" }> {
  const [user] = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    throw new NotFoundError(`User "${userId}" not found`);
  }

  try {
    return await db.transaction(async (tx) => {
      const orgId = uuidv7();
      const memberId = uuidv7();
      await tx.insert(organizations).values({
        id: orgId,
        name: data.name,
        displayName: data.displayName,
        inviteToken: generateInviteToken(),
      });

      const agentName = generateMemberAgentName(memberId);

      // `as unknown as Database` because `createAgent` types its first arg
      // as `Database`, but Drizzle's `Transaction` is a structural superset
      // that supports the same query API. Acceptable here because we run
      // entirely inside the parent tx — if `createAgent` ever opens a
      // nested `db.transaction(…)` it'll savepoint, which is also fine.
      const agent = await createAgent(tx as unknown as Database, {
        name: agentName,
        type: "human",
        displayName: user.displayName,
        organizationId: orgId,
        source: "portal",
        managerId: memberId,
      });

      await tx.insert(members).values({
        id: memberId,
        userId,
        organizationId: orgId,
        agentId: agent.uuid,
        role: "admin",
      });

      return { workspaceId: orgId, memberId, role: "admin" as const };
    });
  } catch (err) {
    throw mapWorkspaceConflict(err, data.name);
  }
}

/**
 * Translate postgres unique-violation errors raised inside the create / join
 * transactions into a user-meaningful `ConflictError`. We inspect the
 * `constraint_name` exposed by postgres-js so the message points at the
 * actual collision instead of always blaming the slug.
 */
function mapWorkspaceConflict(err: unknown, slug: string): unknown {
  const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "";
  if (code !== "23505") return err;
  const constraint =
    (err as { constraint_name?: string }).constraint_name ??
    (err as { cause?: { constraint_name?: string } }).cause?.constraint_name ??
    "";
  if (constraint === "organizations_name_unique") {
    return new ConflictError(`Workspace name "${slug}" is already taken`);
  }
  if (constraint === "uq_members_user_org" || constraint === "members_agent_id_unique") {
    return new ConflictError("You're already a member of this workspace");
  }
  if (constraint === "uq_agents_org_name") {
    return new ConflictError("Workspace creation conflict — please retry");
  }
  // Unknown constraint — surface a generic retry rather than a 500.
  return new ConflictError("Workspace operation conflicted — please retry");
}

/**
 * Extract the bare invite token from either a full URL like
 * `https://hub.first-tree.ai/invite/abc123` or the bare `abc123` string.
 * Returns `null` when the input doesn't match either shape so callers can
 * surface a clear "doesn't look like a valid invite link" error.
 */
export function extractInviteToken(tokenOrUrl: string): string | null {
  const trimmed = tokenOrUrl.trim();
  if (!trimmed) return null;

  // Full URL — extract the last `/invite/<token>` segment. Tolerant of
  // trailing slashes and `?next=…` query strings the user might have
  // accidentally pasted.
  const urlMatch = trimmed.match(/\/invite\/([A-Za-z0-9_-]+)\/?(?:\?.*)?$/);
  if (urlMatch?.[1]) return urlMatch[1];

  // Bare token — must be url-safe base64-ish. We accept the same alphabet
  // generateInviteToken produces; rejecting unknown shapes here keeps
  // garbage out of the WHERE clause.
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;

  return null;
}

/**
 * Look up the workspace a token unlocks. Returns the public-safe subset
 * (no token, no admin-only fields) for landing-page preview rendering.
 */
export async function previewInvite(
  db: Database,
  token: string,
): Promise<{ organizationId: string; organizationDisplayName: string; organizationSlug: string } | null> {
  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      displayName: organizations.displayName,
    })
    .from(organizations)
    .where(eq(organizations.inviteToken, token))
    .limit(1);
  if (!org) return null;
  return {
    organizationId: org.id,
    organizationDisplayName: org.displayName,
    organizationSlug: org.name,
  };
}

/**
 * Join an existing workspace via a public invite token. Atomic:
 *   1. resolve org by invite_token
 *   2. if user is already a member → return existing membership (idempotent)
 *   3. otherwise create members + 1:1 human agents row, role=member
 *
 * Idempotency matters: a user who clicks the same invite link twice should
 * land in the same workspace, not see a 409.
 */
export async function joinWorkspaceByInvite(
  db: Database,
  userId: string,
  token: string,
): Promise<{ workspaceId: string; memberId: string; role: "admin" | "member"; alreadyMember: boolean }> {
  const [user] = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    throw new NotFoundError(`User "${userId}" not found`);
  }

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.inviteToken, token))
    .limit(1);
  if (!org) {
    throw new BadRequestError("This invite link isn't valid. Ask your admin for the correct link.");
  }

  // Idempotent — re-clicking the link drops you back into the same membership.
  const [existing] = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, org.id)))
    .limit(1);
  if (existing) {
    return {
      workspaceId: org.id,
      memberId: existing.id,
      role: existing.role === "admin" ? "admin" : "member",
      alreadyMember: true,
    };
  }

  try {
    return await db.transaction(async (tx) => {
      const memberId = uuidv7();
      const agentName = generateMemberAgentName(memberId);
      // See note in createWorkspaceForUser re: the `as unknown as Database`.
      const agent = await createAgent(tx as unknown as Database, {
        name: agentName,
        type: "human",
        displayName: user.displayName,
        organizationId: org.id,
        source: "portal",
        managerId: memberId,
      });
      await tx.insert(members).values({
        id: memberId,
        userId,
        organizationId: org.id,
        agentId: agent.uuid,
        role: "member",
      });
      return { workspaceId: org.id, memberId, role: "member" as const, alreadyMember: false };
    });
  } catch (err) {
    // Two concurrent join clicks can both pass the existence check above
    // and both INSERT — the second hits `uq_members_user_org`. Recover by
    // re-reading the now-existing membership and surfacing it as the
    // idempotent "already a member" path the route promises.
    const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "";
    const constraint =
      (err as { constraint_name?: string }).constraint_name ??
      (err as { cause?: { constraint_name?: string } }).cause?.constraint_name ??
      "";
    if (code === "23505" && constraint === "uq_members_user_org") {
      const [now] = await db
        .select({ id: members.id, role: members.role })
        .from(members)
        .where(and(eq(members.userId, userId), eq(members.organizationId, org.id)))
        .limit(1);
      if (now) {
        return {
          workspaceId: org.id,
          memberId: now.id,
          role: now.role === "admin" ? "admin" : "member",
          alreadyMember: true,
        };
      }
    }
    throw mapWorkspaceConflict(err, "");
  }
}
