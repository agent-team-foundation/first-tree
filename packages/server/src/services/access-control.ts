/**
 * Shared access-control primitives. Most route-level gating now lives in
 * `scope/require-*.ts` — this module is reduced to two helpers that need
 * SQL building blocks reused across routes and tests:
 *
 *   - `agentVisibilityCondition` — WHERE clause for "agents visible to a
 *     member" (org-visible OR managerId = the caller's member). Composed
 *     into list queries that already select from `agents`.
 *   - `listAgentsManagedByUser` — cross-org list of agents personally
 *     managed by a user; powers the CLI `agent list --remote` view.
 *
 * Visibility is the same for all roles — admin sees the same set as a
 * regular member. Admin privilege is expressed through manageability
 * (`requireAgentAccess(..., "manage")`), not visibility.
 */

import { AGENT_STATUSES, AGENT_TYPES, AGENT_VISIBILITY } from "@first-tree/shared";
import { and, eq, inArray, ne, or, type SQL } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";

/**
 * SQL WHERE conditions for agents visible to a member.
 *   target org + not deleted + (organization-visible OR managerId = caller's member)
 */
export function agentVisibilityCondition(orgId: string, memberId: string): SQL {
  return and(
    eq(agents.organizationId, orgId),
    ne(agents.status, AGENT_STATUSES.DELETED),
    or(eq(agents.visibility, AGENT_VISIBILITY.ORGANIZATION), eq(agents.managerId, memberId)),
  ) as SQL;
}

/**
 * SQL WHERE condition for identities that may be selected as new chat
 * participants. Callers must join `members` as `members.agentId = agents.uuid`
 * before composing this predicate.
 */
export function agentAddressableCondition(): SQL {
  return and(
    eq(agents.status, AGENT_STATUSES.ACTIVE),
    or(ne(agents.type, AGENT_TYPES.HUMAN), eq(members.status, "active")),
  ) as SQL;
}

/**
 * Cross-org listing helper for "agents I personally manage". Used by the
 * CLI `agent list --remote` view — JOINs `agents → members.id` and filters
 * by `members.user_id`.
 */
export async function listAgentsManagedByUser(
  db: Database,
  userId: string,
): Promise<
  Array<{
    uuid: string;
    name: string | null;
    displayName: string;
    type: string;
    organizationId: string;
    inboxId: string;
    visibility: string;
    runtimeProvider: string;
    clientId: string | null;
    /** Lifecycle status (`active` / `suspended`; `deleted` is filtered out
     *  below). Surfaced so callers can exclude suspended agents — a suspended
     *  agent does not bind/run, so it must not be picked as e.g. a seeding agent. */
    status: string;
    avatarImageUpdatedAt: Date | null;
    /**
     * For human agents only: the backing user's external avatar URL
     * (`users.avatar_url`, typically the GitHub avatar). Resolved via a
     * second `members.agent_id → users.id` hop separate from the
     * `agents.managerId → members.id` join used to filter rows above.
     * For non-human agents, the second hop yields no row and this is `null`.
     */
    userAvatarUrl: string | null;
  }>
> {
  // The existing `agents.managerId → members.id` join already lands on
  // the row whose `user_id` we want. For human agents the manager IS the
  // user (members.agent_id = agents.uuid is the same row), so joining
  // `users` off that member yields the correct human-user avatar.
  // For non-human agents we still surface the manager's avatar URL
  // here, but `resolveAvatarImageUrl` ignores it (only honored when
  // type=human), so this is a safe widening of the projection.
  return db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      displayName: agents.displayName,
      type: agents.type,
      organizationId: agents.organizationId,
      inboxId: agents.inboxId,
      visibility: agents.visibility,
      runtimeProvider: agents.runtimeProvider,
      clientId: agents.clientId,
      status: agents.status,
      avatarImageUpdatedAt: agents.avatarImageUpdatedAt,
      userAvatarUrl: users.avatarUrl,
    })
    .from(agents)
    .innerJoin(members, eq(agents.managerId, members.id))
    .leftJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.userId, userId), eq(members.status, "active"), ne(agents.status, AGENT_STATUSES.DELETED)));
}

/**
 * Org-scoped onboarding readiness. Given the caller's memberships (one
 * `(memberId, organizationId)` row per org they belong to), return the set
 * of orgIds in which the member has at least one *usable* non-human agent —
 * usable = active AND (organization-visible OR managed by that member).
 *
 * This is the org-level "is this team set up for me" signal that gates the
 * onboarding create-agent step. A private agent owned by *another* member
 * does NOT count (the caller can't use it), so a freshly-joined or
 * all-private org is correctly reported as not-ready even for a user who
 * already completed onboarding in some other org. One query for the whole
 * membership list — no N+1.
 */
export async function listOrgsWithUsableNonHumanAgent(
  db: Database,
  memberRows: ReadonlyArray<{ memberId: string; organizationId: string }>,
): Promise<Set<string>> {
  if (memberRows.length === 0) return new Set<string>();
  const orgIds = memberRows.map((m) => m.organizationId);
  const memberIds = memberRows.map((m) => m.memberId);
  const rows = await db
    .selectDistinct({ organizationId: agents.organizationId })
    .from(agents)
    .where(
      and(
        inArray(agents.organizationId, orgIds),
        ne(agents.type, "human"),
        eq(agents.status, AGENT_STATUSES.ACTIVE),
        or(eq(agents.visibility, AGENT_VISIBILITY.ORGANIZATION), inArray(agents.managerId, memberIds)),
      ),
    );
  return new Set(rows.map((r) => r.organizationId));
}

/**
 * Org-scoped personal-agent readiness for onboarding. Given the caller's
 * memberships, return the orgIds where that exact membership manages at least
 * one active non-human agent. Organization-visible agents owned by another
 * member deliberately do NOT count: they may be usable in general product
 * surfaces, but onboarding's create-agent step is about creating this member's
 * own teammate in the selected team.
 */
export async function listOrgsWithPersonalAgent(
  db: Database,
  memberRows: ReadonlyArray<{ memberId: string; organizationId: string }>,
): Promise<Set<string>> {
  if (memberRows.length === 0) return new Set<string>();
  const orgIds = memberRows.map((m) => m.organizationId);
  const memberIds = memberRows.map((m) => m.memberId);
  const rows = await db
    .selectDistinct({ organizationId: agents.organizationId })
    .from(agents)
    .where(
      and(
        inArray(agents.organizationId, orgIds),
        inArray(agents.managerId, memberIds),
        ne(agents.type, "human"),
        eq(agents.status, AGENT_STATUSES.ACTIVE),
      ),
    );
  return new Set(rows.map((r) => r.organizationId));
}
