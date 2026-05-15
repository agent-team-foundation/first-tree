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

import { AGENT_STATUSES, AGENT_VISIBILITY } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, ne, or, type SQL } from "drizzle-orm";
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
      avatarImageUpdatedAt: agents.avatarImageUpdatedAt,
      userAvatarUrl: users.avatarUrl,
    })
    .from(agents)
    .innerJoin(members, eq(agents.managerId, members.id))
    .leftJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.userId, userId), eq(members.status, "active"), ne(agents.status, AGENT_STATUSES.DELETED)));
}
