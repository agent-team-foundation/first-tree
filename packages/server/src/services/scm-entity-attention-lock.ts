import { sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";

export type ScmEntityAttentionLock = {
  provider: "github" | "gitlab";
  scopeId: string;
  entityKey: string;
};

/** Commit refs may be abbreviated by unfollow, so serialize them per repo. */
export function githubEntityAttentionLockKey(entityKey: string): string {
  const commitSeparator = entityKey.lastIndexOf("@");
  return commitSeparator > 0 ? `${entityKey.slice(0, commitSeparator)}@commit` : entityKey;
}

export function gitlabPathEntityAttentionLockKey(
  projectPathNormalized: string,
  entityType: "issue" | "pull_request",
  entityIid: number,
): string {
  return `path:${projectPathNormalized}:${entityType}:${entityIid}`;
}

export function gitlabObservedEntityAttentionLockKey(
  projectId: number,
  entityType: "issue" | "pull_request",
  entityIid: number,
): string {
  return `project:${projectId}:${entityType}:${entityIid}`;
}

/**
 * Bridge pending path identity to GitLab's stable numeric project identity.
 * Every caller locks path first, then numeric project ids in ascending order.
 */
export async function lockGitlabEntityAttention(
  db: Database,
  input: {
    connectionId: string;
    projectPathNormalized: string;
    projectIds?: ReadonlyArray<number>;
    entityType: "issue" | "pull_request";
    entityIid: number;
  },
): Promise<void> {
  await lockScmEntityAttention(db, {
    provider: "gitlab",
    scopeId: input.connectionId,
    entityKey: gitlabPathEntityAttentionLockKey(input.projectPathNormalized, input.entityType, input.entityIid),
  });
  const projectIds = [...new Set(input.projectIds ?? [])].sort((a, b) => a - b);
  for (const projectId of projectIds) {
    await lockScmEntityAttention(db, {
      provider: "gitlab",
      scopeId: input.connectionId,
      entityKey: gitlabObservedEntityAttentionLockKey(projectId, input.entityType, input.entityIid),
    });
  }
}

/**
 * Serialize every mutation of one provider entity's attention state.
 *
 * Callers must already be inside the provider lifecycle fence when one
 * exists (GitLab connection row, for example). The transaction-scoped lock
 * then precedes chat-row and mapping locks, giving follow, rebind, unfollow,
 * and webhook placement one stable ordering boundary even before a mapping
 * row exists.
 */
export async function lockScmEntityAttention(db: Database, input: ScmEntityAttentionLock): Promise<void> {
  const key = JSON.stringify([input.provider, input.scopeId, input.entityKey.toLocaleLowerCase("en-US")]);
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('scm_entity_attention'), hashtext(${key}))`);
}

export async function withScmEntityAttentionTransaction<T>(
  db: Database,
  input: ScmEntityAttentionLock,
  callback: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await lockScmEntityAttention(tx, input);
    return callback(tx);
  });
}
