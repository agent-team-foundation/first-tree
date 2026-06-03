import {
  agentRuntimeConfigPayloadSchema,
  canonicalizeResourceRepoUrl,
  deriveRepoLocalPath,
  orgSourceReposStorageSchema,
  type RepoResourcePayload,
} from "@first-tree/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { agents } from "../db/schema/agents.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { resources } from "../db/schema/resources.js";
import { uuidv7 } from "../uuid.js";

export type ResourcesBackfillResult = {
  teamReposCreated: number;
  agentReposCreated: number;
  bindingsCreated: number;
  agentVersionsBumped: number;
  warnings: string[];
};

const BACKFILL_MARKER_NAMESPACE = "resources_phase1_backfill";

export async function backfillResourcesPhase1(db: Database): Promise<ResourcesBackfillResult> {
  const result: ResourcesBackfillResult = {
    teamReposCreated: 0,
    agentReposCreated: 0,
    bindingsCreated: 0,
    agentVersionsBumped: 0,
    warnings: [],
  };

  await db.transaction(async (tx) => {
    const targetDb = tx as unknown as Database;
    await targetDb.execute(sql`SELECT pg_advisory_xact_lock(20260603, 1)`);
    const pendingOrgIds = await listPendingBackfillOrgIds(targetDb);
    if (pendingOrgIds.size === 0) return;
    const affectedAgents = new Set<string>();
    await backfillOrgSourceRepos(targetDb, result, pendingOrgIds, affectedAgents);
    await backfillAgentConfigs(targetDb, result, pendingOrgIds, affectedAgents);
    result.agentVersionsBumped = await bumpAgentConfigVersions(targetDb, affectedAgents);
    await markBackfillComplete(targetDb, pendingOrgIds);
  });
  return result;
}

async function listPendingBackfillOrgIds(db: Database): Promise<Set<string>> {
  const sourceRows = await db
    .select({ organizationId: organizationSettings.organizationId })
    .from(organizationSettings)
    .where(eq(organizationSettings.namespace, "source_repos"));
  const configRows = await db
    .select({ organizationId: agents.organizationId })
    .from(agentConfigs)
    .innerJoin(agents, eq(agents.uuid, agentConfigs.agentId));
  const orgIds = new Set([
    ...sourceRows.map((row) => row.organizationId),
    ...configRows.map((row) => row.organizationId),
  ]);
  if (orgIds.size === 0) return orgIds;
  const completedRows = await db
    .select({ organizationId: organizationSettings.organizationId })
    .from(organizationSettings)
    .where(
      and(
        eq(organizationSettings.namespace, BACKFILL_MARKER_NAMESPACE),
        inArray(organizationSettings.organizationId, Array.from(orgIds)),
      ),
    );
  for (const row of completedRows) orgIds.delete(row.organizationId);
  return orgIds;
}

async function markBackfillComplete(db: Database, orgIds: Set<string>): Promise<void> {
  const completedAt = new Date();
  for (const organizationId of orgIds) {
    await db
      .insert(organizationSettings)
      .values({
        organizationId,
        namespace: BACKFILL_MARKER_NAMESPACE,
        value: { completedAt: completedAt.toISOString(), phase: 1 },
        version: 1,
        updatedBy: null,
        updatedAt: completedAt,
      })
      .onConflictDoUpdate({
        target: [organizationSettings.organizationId, organizationSettings.namespace],
        set: {
          value: { completedAt: completedAt.toISOString(), phase: 1 },
          version: sql`${organizationSettings.version} + 1`,
          updatedBy: null,
          updatedAt: completedAt,
        },
      });
  }
}

async function backfillOrgSourceRepos(
  db: Database,
  result: ResourcesBackfillResult,
  pendingOrgIds: Set<string>,
  affectedAgents: Set<string>,
): Promise<void> {
  const rows = await db.select().from(organizationSettings).where(eq(organizationSettings.namespace, "source_repos"));
  for (const row of rows) {
    if (!pendingOrgIds.has(row.organizationId)) continue;
    const parsed = orgSourceReposStorageSchema.safeParse(row.value);
    if (!parsed.success) {
      result.warnings.push(`source_repos parse failed for org ${row.organizationId}`);
      continue;
    }
    for (const repo of parsed.data.repos) {
      try {
        const created = await ensureTeamRepoResource(db, row.organizationId, {
          url: repo.url,
          ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch } : {}),
        });
        if (created) {
          result.teamReposCreated++;
          for (const agentId of await listRuntimeAgentIds(db, row.organizationId)) affectedAgents.add(agentId);
        }
      } catch (err) {
        result.warnings.push(`source_repos repo skipped for org ${row.organizationId}: ${messageOf(err)}`);
      }
    }
  }
}

async function backfillAgentConfigs(
  db: Database,
  result: ResourcesBackfillResult,
  pendingOrgIds: Set<string>,
  affectedAgents: Set<string>,
): Promise<void> {
  const rows = await db
    .select({
      agentId: agentConfigs.agentId,
      organizationId: agents.organizationId,
      payload: agentConfigs.payload,
    })
    .from(agentConfigs)
    .innerJoin(agents, eq(agents.uuid, agentConfigs.agentId));

  for (const row of rows) {
    if (!pendingOrgIds.has(row.organizationId)) continue;
    const parsed = agentRuntimeConfigPayloadSchema.safeParse(row.payload);
    if (!parsed.success) {
      result.warnings.push(`agent config parse failed for ${row.agentId}`);
      continue;
    }
    for (const repo of parsed.data.gitRepos) {
      try {
        const canonical = canonicalizeResourceRepoUrl(repo.url);
        const team = await findTeamRepoResource(db, row.organizationId, canonical);
        if (team) {
          if (team.status === "retired") continue;
          if (repo.ref || repo.localPath) {
            const created = await ensureBinding(db, {
              organizationId: row.organizationId,
              agentId: row.agentId,
              type: "repo",
              mode: "include",
              resourceId: team.id,
              replacesResourceId: null,
              inlinePromptBody: null,
              repoRef: repo.ref ?? null,
              repoLocalPath: repo.localPath ?? null,
            });
            if (created) {
              result.bindingsCreated++;
              affectedAgents.add(row.agentId);
            }
          }
          continue;
        }

        const agentRepoId = await ensureAgentRepoResource(db, row.organizationId, row.agentId, {
          url: repo.url,
          ...(repo.ref ? { defaultBranch: repo.ref } : {}),
        });
        if (agentRepoId.created) result.agentReposCreated++;
        if (!agentRepoId.id) continue;
        const bindingCreated = await ensureBinding(db, {
          organizationId: row.organizationId,
          agentId: row.agentId,
          type: "repo",
          mode: "include",
          resourceId: agentRepoId.id,
          replacesResourceId: null,
          inlinePromptBody: null,
          repoRef: repo.ref ?? null,
          repoLocalPath: repo.localPath ?? null,
        });
        if (bindingCreated) {
          result.bindingsCreated++;
          affectedAgents.add(row.agentId);
        }
      } catch (err) {
        result.warnings.push(`agent gitRepo skipped for ${row.agentId}: ${messageOf(err)}`);
      }
    }

    const prompt = parsed.data.prompt.append.trim();
    if (prompt.length > 0) {
      const created = await ensureBinding(db, {
        organizationId: row.organizationId,
        agentId: row.agentId,
        type: "prompt",
        mode: "include",
        resourceId: null,
        replacesResourceId: null,
        inlinePromptBody: prompt,
        repoRef: null,
        repoLocalPath: null,
      });
      if (created) {
        result.bindingsCreated++;
        affectedAgents.add(row.agentId);
      }
    }
  }
}

async function ensureTeamRepoResource(
  db: Database,
  organizationId: string,
  payload: RepoResourcePayload,
): Promise<boolean> {
  const canonical = canonicalizeResourceRepoUrl(payload.url);
  const existing = await findTeamRepoResource(db, organizationId, canonical);
  if (existing) return false;
  await db.insert(resources).values({
    id: uuidv7(),
    organizationId,
    type: "repo",
    scope: "team",
    ownerAgentId: null,
    name: deriveRepoLocalPath(payload.url) || payload.url,
    repoCanonicalKey: canonical,
    defaultEnabled: "recommended",
    status: "active",
    payload,
    createdBy: "system",
    updatedBy: "system",
  });
  return true;
}

async function findTeamRepoResource(
  db: Database,
  organizationId: string,
  canonical: string,
): Promise<{ id: string; status: string } | null> {
  const [row] = await db
    .select({ id: resources.id, status: resources.status })
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, organizationId),
        eq(resources.type, "repo"),
        eq(resources.scope, "team"),
        eq(resources.repoCanonicalKey, canonical),
        inArray(resources.status, ["active", "stale", "retired"]),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function ensureAgentRepoResource(
  db: Database,
  organizationId: string,
  agentId: string,
  payload: RepoResourcePayload,
): Promise<{ id: string | null; created: boolean }> {
  const canonical = canonicalizeResourceRepoUrl(payload.url);
  const [existing] = await db
    .select({ id: resources.id, status: resources.status })
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, organizationId),
        eq(resources.type, "repo"),
        eq(resources.scope, "agent"),
        eq(resources.ownerAgentId, agentId),
        eq(resources.repoCanonicalKey, canonical),
        inArray(resources.status, ["active", "stale", "retired"]),
      ),
    )
    .limit(1);
  if (existing) return { id: existing.status === "retired" ? null : existing.id, created: false };
  const id = uuidv7();
  await db.insert(resources).values({
    id,
    organizationId,
    type: "repo",
    scope: "agent",
    ownerAgentId: agentId,
    name: deriveRepoLocalPath(payload.url) || payload.url,
    repoCanonicalKey: canonical,
    defaultEnabled: null,
    status: "active",
    payload,
    createdBy: "system",
    updatedBy: "system",
  });
  return { id, created: true };
}

async function listRuntimeAgentIds(db: Database, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(eq(agents.organizationId, organizationId), ne(agents.status, "deleted"), ne(agents.type, "human")));
  return rows.map((row) => row.uuid);
}

async function bumpAgentConfigVersions(db: Database, agentIds: Set<string>): Promise<number> {
  const ids = Array.from(agentIds);
  if (ids.length === 0) return 0;
  await db
    .update(agentConfigs)
    .set({
      version: sql`${agentConfigs.version} + 1`,
      updatedAt: new Date(),
      updatedBy: "system",
    })
    .where(inArray(agentConfigs.agentId, ids));
  return ids.length;
}

async function ensureBinding(
  db: Database,
  row: {
    organizationId: string;
    agentId: string;
    type: "repo" | "prompt" | "skill" | "mcp";
    mode: "include" | "disable" | "replace";
    resourceId: string | null;
    replacesResourceId: string | null;
    inlinePromptBody: string | null;
    repoRef: string | null;
    repoLocalPath: string | null;
  },
): Promise<boolean> {
  const existingRows = await db
    .select({ id: agentResourceBindings.id })
    .from(agentResourceBindings)
    .where(and(eq(agentResourceBindings.agentId, row.agentId), eq(agentResourceBindings.type, row.type)));
  const duplicate =
    existingRows.length > 0
      ? await db
          .select({ id: agentResourceBindings.id })
          .from(agentResourceBindings)
          .where(
            and(
              eq(agentResourceBindings.agentId, row.agentId),
              eq(agentResourceBindings.type, row.type),
              row.resourceId === null
                ? sqlIsNull(agentResourceBindings.resourceId)
                : eq(agentResourceBindings.resourceId, row.resourceId),
              row.inlinePromptBody === null
                ? sqlIsNull(agentResourceBindings.inlinePromptBody)
                : eq(agentResourceBindings.inlinePromptBody, row.inlinePromptBody),
            ),
          )
          .limit(1)
      : [];
  if (duplicate.length > 0) return false;
  await db.insert(agentResourceBindings).values({
    id: uuidv7(),
    organizationId: row.organizationId,
    agentId: row.agentId,
    type: row.type,
    mode: row.mode,
    resourceId: row.resourceId,
    replacesResourceId: row.replacesResourceId,
    inlinePromptBody: row.inlinePromptBody,
    repoRef: row.repoRef,
    repoLocalPath: row.repoLocalPath,
    order: existingRows.length + 1,
    createdBy: "system",
    updatedBy: "system",
  });
  return true;
}

function sqlIsNull(column: typeof agentResourceBindings.resourceId | typeof agentResourceBindings.inlinePromptBody) {
  return sql`${column} IS NULL`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
