import type { GitlabSkippedTargetAudit, GitlabSkippedTargetReason, GitlabTargetClass } from "@first-tree/shared";
import { and, desc, eq, gt, inArray, lt } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { gitlabSkippedTargetAudit } from "../db/schema/gitlab-skipped-target-audit.js";
import { uuidv7 } from "../uuid.js";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function recordGitlabSkippedTarget(
  db: Database,
  input: {
    organizationId: string;
    connectionId: string;
    entityKey: string;
    targetClass: GitlabTargetClass;
    externalUsername: string;
    reason: GitlabSkippedTargetReason;
  },
): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  await db.insert(gitlabSkippedTargetAudit).values({ id: uuidv7(), ...input, createdAt: new Date() });
  const expiredBatch = db
    .select({ id: gitlabSkippedTargetAudit.id })
    .from(gitlabSkippedTargetAudit)
    .where(
      and(
        eq(gitlabSkippedTargetAudit.organizationId, input.organizationId),
        lt(gitlabSkippedTargetAudit.createdAt, cutoff),
      ),
    )
    .limit(200);
  // Indexed, org-bounded and row-bounded opportunistic cleanup; no worker or unbounded scan.
  await db.delete(gitlabSkippedTargetAudit).where(inArray(gitlabSkippedTargetAudit.id, expiredBatch));
}

export async function listRecentGitlabSkippedTargets(
  db: Database,
  organizationId: string,
  limit = 100,
): Promise<GitlabSkippedTargetAudit[]> {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  const rows = await db
    .select()
    .from(gitlabSkippedTargetAudit)
    .where(
      and(eq(gitlabSkippedTargetAudit.organizationId, organizationId), gt(gitlabSkippedTargetAudit.createdAt, cutoff)),
    )
    .orderBy(desc(gitlabSkippedTargetAudit.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    entityKey: row.entityKey,
    targetClass: row.targetClass as GitlabTargetClass,
    externalUsername: row.externalUsername,
    reason: row.reason as GitlabSkippedTargetReason,
    createdAt: row.createdAt.toISOString(),
  }));
}
