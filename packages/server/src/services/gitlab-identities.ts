import type {
  GitlabIdentityLinkSummary,
  GitlabIdentityTransition,
  GitlabIdentityTransitionAudit,
} from "@first-tree/shared";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { gitlabIdentityLinks } from "../db/schema/gitlab-identity-links.js";
import { gitlabIdentityTransitionAudit } from "../db/schema/gitlab-identity-transition-audit.js";
import { members } from "../db/schema/members.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";

const PG_UNIQUE_VIOLATION = "23505";

function postgresErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const direct = "code" in err && typeof err.code === "string" ? err.code : undefined;
  if (direct) return direct;
  if ("cause" in err) return postgresErrorCode(err.cause);
  return undefined;
}

export function normalizeGitlabUsername(raw: string): { display: string; normalized: string } {
  const trimmed = raw.trim();
  const display = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!display || display.length > 255 || !/^[A-Za-z0-9_.-]+$/.test(display)) {
    throw new BadRequestError("GitLab username must contain only letters, numbers, '.', '_' or '-'");
  }
  return { display, normalized: display.toLocaleLowerCase("en-US") };
}

function serializeLink(row: typeof gitlabIdentityLinks.$inferSelect): GitlabIdentityLinkSummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    membershipId: row.membershipId,
    connectionId: row.connectionId,
    instanceOrigin: row.instanceOrigin,
    displayUsername: row.displayUsername,
    normalizedUsername: row.normalizedUsername,
    state: row.state as GitlabIdentityLinkSummary["state"],
    stateReason: row.stateReason,
    createdByMemberId: row.createdByMemberId,
    confirmedByMemberId: row.confirmedByMemberId,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    suspendedByMemberId: row.suspendedByMemberId,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    revokedByMemberId: row.revokedByMemberId,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeTransition(row: typeof gitlabIdentityTransitionAudit.$inferSelect): GitlabIdentityTransitionAudit {
  return {
    ...row,
    transition: row.transition as GitlabIdentityTransition,
    createdAt: row.createdAt.toISOString(),
  };
}

async function recordIdentityTransition(
  db: Database,
  link: Pick<
    typeof gitlabIdentityLinks.$inferSelect,
    | "id"
    | "organizationId"
    | "connectionId"
    | "instanceOrigin"
    | "membershipId"
    | "displayUsername"
    | "normalizedUsername"
  >,
  input: {
    transition: GitlabIdentityTransition;
    actorMemberId: string | null;
    reason: string | null;
    createdAt?: Date;
  },
): Promise<void> {
  await db.insert(gitlabIdentityTransitionAudit).values({
    id: uuidv7(),
    organizationId: link.organizationId,
    identityLinkId: link.id,
    connectionId: link.connectionId,
    instanceOrigin: link.instanceOrigin,
    membershipId: link.membershipId,
    displayUsername: link.displayUsername,
    normalizedUsername: link.normalizedUsername,
    transition: input.transition,
    actorMemberId: input.actorMemberId,
    reason: input.reason,
    createdAt: input.createdAt ?? new Date(),
  });
}

export async function listGitlabIdentityLinks(
  db: Database,
  organizationId: string,
): Promise<GitlabIdentityLinkSummary[]> {
  const rows = await db
    .select()
    .from(gitlabIdentityLinks)
    .where(eq(gitlabIdentityLinks.organizationId, organizationId))
    .orderBy(gitlabIdentityLinks.createdAt);
  return rows.map(serializeLink);
}

export async function listGitlabIdentityTransitionAudit(
  db: Database,
  organizationId: string,
): Promise<GitlabIdentityTransitionAudit[]> {
  const rows = await db
    .select()
    .from(gitlabIdentityTransitionAudit)
    .where(eq(gitlabIdentityTransitionAudit.organizationId, organizationId))
    .orderBy(desc(gitlabIdentityTransitionAudit.createdAt))
    .limit(100);
  return rows.map(serializeTransition);
}

export async function createGitlabIdentityLink(
  db: Database,
  input: {
    organizationId: string;
    connectionId: string;
    membershipId: string;
    username: string;
    actorMemberId: string;
  },
): Promise<GitlabIdentityLinkSummary> {
  const username = normalizeGitlabUsername(input.username);
  try {
    const row = await db.transaction(async (tx) => {
      const [connection] = await tx
        .select()
        .from(gitlabConnections)
        .where(
          and(eq(gitlabConnections.id, input.connectionId), eq(gitlabConnections.organizationId, input.organizationId)),
        )
        .for("update")
        .limit(1);
      if (!connection) throw new NotFoundError("GitLab connection not found");

      const [membership] = await tx
        .select({ id: members.id, status: members.status })
        .from(members)
        .where(and(eq(members.id, input.membershipId), eq(members.organizationId, input.organizationId)))
        .for("update")
        .limit(1);
      if (!membership) throw new NotFoundError("Membership not found");
      if (membership.status !== "active") throw new ConflictError("GitLab identity requires an active membership");

      const now = new Date();
      const [created] = await tx
        .insert(gitlabIdentityLinks)
        .values({
          id: uuidv7(),
          organizationId: input.organizationId,
          membershipId: input.membershipId,
          connectionId: connection.id,
          instanceOrigin: connection.instanceOrigin,
          displayUsername: username.display,
          normalizedUsername: username.normalized,
          state: "active",
          createdByMemberId: input.actorMemberId,
          confirmedByMemberId: input.actorMemberId,
          confirmedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!created) throw new Error("GitLab identity link insert returned no row");
      await recordIdentityTransition(tx as unknown as Database, created, {
        transition: "created",
        actorMemberId: input.actorMemberId,
        reason: "admin_created",
        createdAt: now,
      });
      return created;
    });
    return serializeLink(row);
  } catch (err) {
    if (postgresErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ConflictError("That membership or GitLab username already has an active link for this connection");
    }
    throw err;
  }
}

async function getLinkForUpdate(db: Database, linkId: string, organizationId: string) {
  const [link] = await db
    .select()
    .from(gitlabIdentityLinks)
    .where(and(eq(gitlabIdentityLinks.id, linkId), eq(gitlabIdentityLinks.organizationId, organizationId)))
    .for("update")
    .limit(1);
  if (!link) throw new NotFoundError("GitLab identity link not found");
  return link;
}

async function disableIdentityMappings(db: Database, linkIds: string[]): Promise<void> {
  if (linkIds.length === 0) return;
  await db
    .update(gitlabEntityChatMappings)
    .set({ active: false, updatedAt: new Date() })
    .where(and(inArray(gitlabEntityChatMappings.identityLinkId, linkIds), eq(gitlabEntityChatMappings.active, true)));
}

export async function suspendGitlabIdentityLink(
  db: Database,
  input: { organizationId: string; linkId: string; actorMemberId: string; reason?: string },
): Promise<GitlabIdentityLinkSummary> {
  const row = await db.transaction(async (tx) => {
    const link = await getLinkForUpdate(tx as unknown as Database, input.linkId, input.organizationId);
    if (link.state === "revoked") throw new ConflictError("Revoked GitLab identity links are terminal");
    if (link.state === "suspended") return link;
    const now = new Date();
    const reason = input.reason ?? "admin_suspended";
    const [updated] = await tx
      .update(gitlabIdentityLinks)
      .set({
        state: "suspended",
        stateReason: reason,
        suspendedByMemberId: input.actorMemberId,
        suspendedAt: now,
        updatedAt: now,
      })
      .where(eq(gitlabIdentityLinks.id, link.id))
      .returning();
    await disableIdentityMappings(tx as unknown as Database, [link.id]);
    if (!updated) throw new Error("GitLab identity suspension returned no row");
    await recordIdentityTransition(tx as unknown as Database, link, {
      transition: "suspended",
      actorMemberId: input.actorMemberId,
      reason,
      createdAt: now,
    });
    return updated;
  });
  return serializeLink(row);
}

export async function revokeGitlabIdentityLink(
  db: Database,
  input: { organizationId: string; linkId: string; actorMemberId: string; reason?: string },
): Promise<GitlabIdentityLinkSummary> {
  const row = await db.transaction(async (tx) => {
    const link = await getLinkForUpdate(tx as unknown as Database, input.linkId, input.organizationId);
    if (link.state === "revoked") return link;
    const now = new Date();
    const reason = input.reason ?? "admin_revoked";
    const [updated] = await tx
      .update(gitlabIdentityLinks)
      .set({
        state: "revoked",
        stateReason: reason,
        revokedByMemberId: input.actorMemberId,
        revokedAt: now,
        updatedAt: now,
      })
      .where(eq(gitlabIdentityLinks.id, link.id))
      .returning();
    await disableIdentityMappings(tx as unknown as Database, [link.id]);
    if (!updated) throw new Error("GitLab identity revocation returned no row");
    await recordIdentityTransition(tx as unknown as Database, link, {
      transition: "revoked",
      actorMemberId: input.actorMemberId,
      reason,
      createdAt: now,
    });
    return updated;
  });
  return serializeLink(row);
}

export async function reconfirmGitlabIdentityLink(
  db: Database,
  input: { organizationId: string; linkId: string; actorMemberId: string; reason?: string },
): Promise<GitlabIdentityLinkSummary> {
  try {
    const row = await db.transaction(async (tx) => {
      const [snapshot] = await tx
        .select({
          connectionId: gitlabIdentityLinks.connectionId,
          membershipId: gitlabIdentityLinks.membershipId,
        })
        .from(gitlabIdentityLinks)
        .where(
          and(eq(gitlabIdentityLinks.id, input.linkId), eq(gitlabIdentityLinks.organizationId, input.organizationId)),
        )
        .limit(1);
      if (!snapshot) throw new NotFoundError("GitLab identity link not found");
      if (!snapshot.connectionId) {
        throw new ConflictError("The original GitLab connection was removed; create a new identity link");
      }
      const [connection] = await tx
        .select({ id: gitlabConnections.id })
        .from(gitlabConnections)
        .where(
          and(
            eq(gitlabConnections.id, snapshot.connectionId),
            eq(gitlabConnections.organizationId, input.organizationId),
          ),
        )
        .for("update")
        .limit(1);
      if (!connection)
        throw new ConflictError("The original GitLab connection was removed; create a new identity link");
      const [membership] = await tx
        .select({ status: members.status })
        .from(members)
        .where(and(eq(members.id, snapshot.membershipId), eq(members.organizationId, input.organizationId)))
        .for("update")
        .limit(1);
      const link = await getLinkForUpdate(tx as unknown as Database, input.linkId, input.organizationId);
      if (link.connectionId !== connection.id || link.membershipId !== snapshot.membershipId) {
        throw new ConflictError("The original GitLab connection was removed; create a new identity link");
      }
      if (link.state === "revoked") throw new ConflictError("Revoked GitLab identity links cannot be reactivated");
      if (link.state === "active") return link;
      if (!membership || membership.status !== "active") {
        throw new ConflictError("GitLab identity can only be reconfirmed for an active membership");
      }
      const now = new Date();
      const reason = input.reason ?? "admin_reconfirmed";
      const [updated] = await tx
        .update(gitlabIdentityLinks)
        .set({
          state: "active",
          stateReason: reason,
          confirmedByMemberId: input.actorMemberId,
          confirmedAt: now,
          suspendedByMemberId: null,
          suspendedAt: null,
          updatedAt: now,
        })
        .where(eq(gitlabIdentityLinks.id, link.id))
        .returning();
      if (!updated) throw new Error("GitLab identity reconfirmation returned no row");
      await recordIdentityTransition(tx as unknown as Database, link, {
        transition: "reconfirmed",
        actorMemberId: input.actorMemberId,
        reason,
        createdAt: now,
      });
      return updated;
    });
    return serializeLink(row);
  } catch (err) {
    if (postgresErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ConflictError("That membership or GitLab username already has an active link for this connection");
    }
    throw err;
  }
}

/** Membership leave/removal hook. The caller already owns the member lifecycle transaction. */
export async function suspendGitlabLinksForMembership(
  db: Database,
  membershipId: string,
  reason: "member_left" | "member_removed",
  actorMemberId: string | null = null,
): Promise<void> {
  const active = await db
    .select()
    .from(gitlabIdentityLinks)
    .where(and(eq(gitlabIdentityLinks.membershipId, membershipId), eq(gitlabIdentityLinks.state, "active")))
    .for("update");
  if (active.length === 0) return;
  const ids = active.map((row) => row.id);
  await db
    .update(gitlabIdentityLinks)
    .set({ state: "suspended", stateReason: reason, suspendedAt: new Date(), updatedAt: new Date() })
    .where(inArray(gitlabIdentityLinks.id, ids));
  await disableIdentityMappings(db, ids);
  const now = new Date();
  for (const link of active) {
    await recordIdentityTransition(db, link, {
      transition: reason,
      actorMemberId,
      reason,
      createdAt: now,
    });
  }
}

/** Connection replace/delete hook. Links stay as audit snapshots and never transfer to the replacement. */
export async function suspendGitlabLinksForConnection(
  db: Database,
  connectionId: string,
  actorMemberId: string | null = null,
): Promise<void> {
  const links = await db
    .select()
    .from(gitlabIdentityLinks)
    .where(eq(gitlabIdentityLinks.connectionId, connectionId))
    .orderBy(asc(gitlabIdentityLinks.id))
    .for("update");
  if (links.length === 0) return;
  const activeIds = links.filter((row) => row.state === "active").map((row) => row.id);
  if (activeIds.length > 0) {
    await db
      .update(gitlabIdentityLinks)
      .set({ state: "suspended", stateReason: "connection_removed", suspendedAt: new Date(), updatedAt: new Date() })
      .where(inArray(gitlabIdentityLinks.id, activeIds));
    await disableIdentityMappings(db, activeIds);
  }
  const now = new Date();
  for (const link of links) {
    await recordIdentityTransition(db, link, {
      transition: "connection_removed",
      actorMemberId,
      reason: "connection_removed",
      createdAt: now,
    });
  }
}

export type ResolvedGitlabIdentity = {
  linkId: string;
  membershipId: string;
  humanAgentId: string;
  delegateAgentId: string;
};

/**
 * Acquires every identity authority needed by one delivery in the same
 * membership → identity-link order used by membership lifecycle changes.
 * The connection fence is owned by the caller.
 */
export async function lockGitlabIdentityAuthoritySet(
  db: Database,
  input: {
    organizationId: string;
    connectionId: string;
    normalizedUsernames: string[];
    identityLinkIds: string[];
  },
): Promise<void> {
  const selectors = [];
  if (input.normalizedUsernames.length > 0) {
    selectors.push(inArray(gitlabIdentityLinks.normalizedUsername, [...new Set(input.normalizedUsernames)].sort()));
  }
  if (input.identityLinkIds.length > 0) {
    selectors.push(inArray(gitlabIdentityLinks.id, [...new Set(input.identityLinkIds)].sort()));
  }
  if (selectors.length === 0) return;
  const snapshots = await db
    .select({ id: gitlabIdentityLinks.id, membershipId: gitlabIdentityLinks.membershipId })
    .from(gitlabIdentityLinks)
    .where(
      and(
        eq(gitlabIdentityLinks.organizationId, input.organizationId),
        eq(gitlabIdentityLinks.connectionId, input.connectionId),
        eq(gitlabIdentityLinks.state, "active"),
        or(...selectors),
      ),
    );
  if (snapshots.length === 0) return;
  const membershipIds = [...new Set(snapshots.map((row) => row.membershipId))].sort();
  await db
    .select({ id: members.id })
    .from(members)
    .where(inArray(members.id, membershipIds))
    .orderBy(asc(members.id))
    .for("update");
  await db
    .select({ id: gitlabIdentityLinks.id })
    .from(gitlabIdentityLinks)
    .where(inArray(gitlabIdentityLinks.id, snapshots.map((row) => row.id).sort()))
    .orderBy(asc(gitlabIdentityLinks.id))
    .for("update");
}

export async function resolveActiveGitlabIdentity(
  db: Database,
  input: {
    organizationId: string;
    connectionId: string;
    normalizedUsername: string;
    /** Holds membership + identity authority through the caller's transaction commit. */
    lockForUpdate?: boolean;
  },
): Promise<
  | { outcome: "ok"; identity: ResolvedGitlabIdentity }
  | {
      outcome:
        | "identity_not_found"
        | "identity_not_active"
        | "membership_not_active"
        | "delegate_missing"
        | "delegate_ineligible";
    }
> {
  const linkScope = and(
    eq(gitlabIdentityLinks.organizationId, input.organizationId),
    eq(gitlabIdentityLinks.connectionId, input.connectionId),
    eq(gitlabIdentityLinks.normalizedUsername, input.normalizedUsername),
  );
  const [linkSnapshot] = await db
    .select()
    .from(gitlabIdentityLinks)
    .where(and(linkScope, eq(gitlabIdentityLinks.state, "active")))
    .limit(1);
  if (!linkSnapshot) {
    const [inactive] = await db
      .select({ id: gitlabIdentityLinks.id })
      .from(gitlabIdentityLinks)
      .where(linkScope)
      .limit(1);
    return { outcome: inactive ? "identity_not_active" : "identity_not_found" };
  }

  const membershipRows = input.lockForUpdate
    ? await db
        .select({ status: members.status, humanAgentId: members.agentId })
        .from(members)
        .where(and(eq(members.id, linkSnapshot.membershipId), eq(members.organizationId, input.organizationId)))
        .for("update")
        .limit(1)
    : await db
        .select({ status: members.status, humanAgentId: members.agentId })
        .from(members)
        .where(and(eq(members.id, linkSnapshot.membershipId), eq(members.organizationId, input.organizationId)))
        .limit(1);
  const [membership] = membershipRows;
  if (!membership || membership.status !== "active") return { outcome: "membership_not_active" };

  let link = linkSnapshot;
  if (input.lockForUpdate) {
    const [lockedLink] = await db
      .select()
      .from(gitlabIdentityLinks)
      .where(
        and(
          eq(gitlabIdentityLinks.id, linkSnapshot.id),
          linkScope,
          eq(gitlabIdentityLinks.membershipId, linkSnapshot.membershipId),
          eq(gitlabIdentityLinks.state, "active"),
        ),
      )
      .for("update")
      .limit(1);
    if (!lockedLink) return { outcome: "identity_not_active" };
    link = lockedLink;
  }

  const humanRows = input.lockForUpdate
    ? await db
        .select({ status: agents.status, delegateAgentId: agents.delegateMention })
        .from(agents)
        .where(and(eq(agents.uuid, membership.humanAgentId), eq(agents.organizationId, input.organizationId)))
        .for("update")
        .limit(1)
    : await db
        .select({ status: agents.status, delegateAgentId: agents.delegateMention })
        .from(agents)
        .where(and(eq(agents.uuid, membership.humanAgentId), eq(agents.organizationId, input.organizationId)))
        .limit(1);
  const [human] = humanRows;
  if (!human || human.status !== "active") return { outcome: "membership_not_active" };
  if (!human.delegateAgentId) return { outcome: "delegate_missing" };
  const delegateRows = input.lockForUpdate
    ? await db
        .select({ status: agents.status, organizationId: agents.organizationId, type: agents.type })
        .from(agents)
        .where(eq(agents.uuid, human.delegateAgentId))
        .for("update")
        .limit(1)
    : await db
        .select({ status: agents.status, organizationId: agents.organizationId, type: agents.type })
        .from(agents)
        .where(eq(agents.uuid, human.delegateAgentId))
        .limit(1);
  const [delegate] = delegateRows;
  if (
    !delegate ||
    delegate.organizationId !== input.organizationId ||
    delegate.status !== "active" ||
    delegate.type === "human"
  ) {
    return { outcome: "delegate_ineligible" };
  }
  return {
    outcome: "ok",
    identity: {
      linkId: link.id,
      membershipId: link.membershipId,
      humanAgentId: membership.humanAgentId,
      delegateAgentId: human.delegateAgentId,
    },
  };
}
