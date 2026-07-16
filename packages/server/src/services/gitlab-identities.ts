import type { GitlabIdentityLinkSummary } from "@first-tree/shared";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { gitlabIdentityLinks } from "../db/schema/gitlab-identity-links.js";
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
    displayUsername: row.displayUsername,
    normalizedUsername: row.normalizedUsername,
    state: row.state as GitlabIdentityLinkSummary["state"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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

export async function createGitlabIdentityLink(
  db: Database,
  input: {
    organizationId: string;
    connectionId: string;
    membershipId: string;
    username: string;
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
          displayUsername: username.display,
          normalizedUsername: username.normalized,
          state: "active",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!created) throw new Error("GitLab identity link insert returned no row");
      return created;
    });
    return serializeLink(row);
  } catch (err) {
    if (postgresErrorCode(err) === PG_UNIQUE_VIOLATION) {
      throw new ConflictError("That membership or GitLab username already has a link for this connection");
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

export async function removeGitlabIdentityLink(
  db: Database,
  input: { organizationId: string; linkId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const link = await getLinkForUpdate(tx as unknown as Database, input.linkId, input.organizationId);
    const [deleted] = await tx
      .delete(gitlabIdentityLinks)
      .where(eq(gitlabIdentityLinks.id, link.id))
      .returning({ id: gitlabIdentityLinks.id });
    if (!deleted) throw new NotFoundError("GitLab identity link not found");
  });
}

export async function reconfirmGitlabIdentityLink(
  db: Database,
  input: { organizationId: string; linkId: string },
): Promise<GitlabIdentityLinkSummary> {
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
    if (!connection) throw new ConflictError("The GitLab connection was removed; create a new identity link");
    const [membership] = await tx
      .select({ status: members.status })
      .from(members)
      .where(and(eq(members.id, snapshot.membershipId), eq(members.organizationId, input.organizationId)))
      .for("update")
      .limit(1);
    const link = await getLinkForUpdate(tx as unknown as Database, input.linkId, input.organizationId);
    if (link.connectionId !== connection.id || link.membershipId !== snapshot.membershipId) {
      throw new ConflictError("The GitLab connection was removed; create a new identity link");
    }
    if (link.state === "active") return link;
    if (!membership || membership.status !== "active") {
      throw new ConflictError("GitLab identity can only be reconfirmed for an active membership");
    }
    const now = new Date();
    const [updated] = await tx
      .update(gitlabIdentityLinks)
      .set({ state: "active", updatedAt: now })
      .where(eq(gitlabIdentityLinks.id, link.id))
      .returning();
    if (!updated) throw new Error("GitLab identity reconfirmation returned no row");
    return updated;
  });
  return serializeLink(row);
}

/** Membership leave/removal hook. The caller already owns the member lifecycle transaction. */
export async function suspendGitlabLinksForMembership(db: Database, membershipId: string): Promise<void> {
  const active = await db
    .select()
    .from(gitlabIdentityLinks)
    .where(and(eq(gitlabIdentityLinks.membershipId, membershipId), eq(gitlabIdentityLinks.state, "active")))
    .for("update");
  if (active.length === 0) return;
  const ids = active.map((row) => row.id);
  await db
    .update(gitlabIdentityLinks)
    .set({
      state: "suspended",
      updatedAt: new Date(),
    })
    .where(inArray(gitlabIdentityLinks.id, ids));
  await disableIdentityMappings(db, ids);
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
