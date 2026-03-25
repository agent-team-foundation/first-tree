import { AGENT_STATUSES, type SyncReport } from "@agent-hub/shared";
import { eq, ne } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import * as agentService from "./agent.js";
import { type MemberEntry, readMembers } from "./tree-reader.js";

// In-memory store for most recent sync result
let lastSyncReport: SyncReport | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;

export function getLastSyncReport(): SyncReport | null {
  return lastSyncReport;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildTreeMeta(member: MemberEntry): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  if (member.role) tree.role = member.role;
  if (member.domains) tree.domains = member.domains;
  if (member.owners) tree.owners = member.owners;
  return tree;
}

/**
 * Merge tree-managed fields into existing metadata without overwriting
 * other namespaces (e.g. metadata.github).
 */
function mergeMetadata(existing: Record<string, unknown>, treeMeta: Record<string, unknown>): Record<string, unknown> {
  return { ...existing, tree: treeMeta };
}

function needsUpdate(
  agent: { type: string; displayName: string | null; metadata: Record<string, unknown> },
  member: MemberEntry,
): boolean {
  if (agent.type !== member.type) return true;
  if (agent.displayName !== member.title) return true;
  const existingTree = (agent.metadata?.tree ?? {}) as Record<string, unknown>;
  if (!deepEqual(existingTree, buildTreeMeta(member))) return true;
  return false;
}

/**
 * Core sync: read context tree members, compare with DB, create/update/suspend.
 */
export async function syncAgents(db: Database, treePath: string): Promise<SyncReport> {
  const report: SyncReport = {
    syncedAt: new Date().toISOString(),
    treePath,
    summary: { created: 0, updated: 0, suspended: 0, unchanged: 0, errors: 0 },
    created: [],
    updated: [],
    suspended: [],
    errors: [],
  };

  // 1. Read tree
  const { members, errors: readErrors } = await readMembers(treePath);
  for (const err of readErrors) {
    report.errors.push(err);
  }

  // 2. Read DB — all non-deleted agents
  const dbAgents = await db.select().from(agents).where(ne(agents.status, AGENT_STATUSES.DELETED));

  // 3. Build lookup maps
  const treeMap = new Map(members.map((m) => [m.id, m]));
  const dbMap = new Map(dbAgents.map((a) => [a.id, a]));

  // 4a. Create or update from tree
  for (const member of members) {
    const existing = dbMap.get(member.id);
    const treeMeta = buildTreeMeta(member);

    if (!existing) {
      try {
        await agentService.createAgent(db, {
          id: member.id,
          type: member.type,
          displayName: member.title,
          metadata: { tree: treeMeta },
        });
        report.created.push(member.id);
        report.summary.created++;
      } catch (err) {
        report.errors.push({ memberId: member.id, error: `Failed to create: ${String(err)}` });
      }
      continue;
    }

    // Existing agent — check if needs update or reactivation
    let updated = false;
    const merged = mergeMetadata(existing.metadata, treeMeta);

    if (existing.status === AGENT_STATUSES.SUSPENDED) {
      // Reactivate — member reappeared in tree
      await db
        .update(agents)
        .set({
          status: AGENT_STATUSES.ACTIVE,
          type: member.type,
          displayName: member.title,
          metadata: merged,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, member.id));
      updated = true;
    } else if (needsUpdate(existing, member)) {
      await db
        .update(agents)
        .set({
          type: member.type,
          displayName: member.title,
          metadata: merged,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, member.id));
      updated = true;
    }

    if (updated) {
      report.updated.push(member.id);
      report.summary.updated++;
    } else {
      report.summary.unchanged++;
    }
  }

  // 4b. Suspend orphans — agents in DB but not in tree
  // Skip managed agents (e.g. github-adapter) — they are created by the system, not the tree
  for (const agent of dbAgents) {
    if (!treeMap.has(agent.id) && agent.status === AGENT_STATUSES.ACTIVE && !agent.metadata?.managed) {
      try {
        await agentService.suspendAgent(db, agent.id);
        report.suspended.push(agent.id);
        report.summary.suspended++;
      } catch (err) {
        report.errors.push({ memberId: agent.id, error: `Failed to suspend: ${String(err)}` });
      }
    }
  }

  report.summary.errors = report.errors.length;

  lastSyncReport = report;
  return report;
}

/**
 * Start periodic sync.
 */
export function startPeriodicSync(
  db: Database,
  treePath: string,
  intervalSeconds: number,
  log: { info: (msg: string) => void; error: (err: unknown, msg: string) => void },
): void {
  if (syncTimer) {
    clearInterval(syncTimer);
  }
  if (intervalSeconds <= 0) return;

  syncTimer = setInterval(async () => {
    try {
      const report = await syncAgents(db, treePath);
      const s = report.summary;
      if (s.created > 0 || s.updated > 0 || s.suspended > 0 || s.errors > 0) {
        log.info(`Agent sync: created=${s.created} updated=${s.updated} suspended=${s.suspended} errors=${s.errors}`);
      }
    } catch (err) {
      log.error(err, "Periodic agent sync failed");
    }
  }, intervalSeconds * 1000);
}

export function stopPeriodicSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}
