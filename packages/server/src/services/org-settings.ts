import {
  type ContextTreeActiveBinding,
  type ContextTreeSettingState,
  classifyContextTreeSetting,
  contextTreeActiveBindingSchema,
  contextTreeBranchSchema,
  isOrgSettingNamespace,
  ORG_SETTINGS_NAMESPACES,
  type OrgContextTreeFeaturesStorage,
  type OrgContextTreeStorage,
  type OrgSettingInput,
  type OrgSettingNamespace,
  type OrgSettingOutput,
  type OrgSettingStorage,
} from "@first-tree/shared";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { pickDefaultMembership } from "./auth.js";
import { findInstallationByOrg } from "./github-app-installations.js";

/**
 * Per-organization settings, keyed by `(organizationId, namespace)`. The
 * registry of valid namespaces and their storage / input / output schemas
 * lives in `@first-tree/shared`.
 *
 * Read path:  storage row → output (mask)
 * Write path: input → validate → merge with current storage → upsert (in tx)
 *
 * The generic getter returns the masked output. Per-namespace plaintext
 * accessors live alongside this module when a secret needs to leave the
 * encrypted-at-rest boundary (none today).
 */

function assertNamespace(ns: string): asserts ns is OrgSettingNamespace {
  if (!isOrgSettingNamespace(ns)) {
    throw new BadRequestError(`Unknown organization-settings namespace: "${ns}"`);
  }
}

async function fetchStorageRow<K extends OrgSettingNamespace>(
  db: Database,
  orgId: string,
  namespace: K,
): Promise<OrgSettingStorage<K> | null> {
  const [row] = await db
    .select({ value: organizationSettings.value })
    .from(organizationSettings)
    .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, namespace)))
    .limit(1);
  if (!row) return null;
  const schema = ORG_SETTINGS_NAMESPACES[namespace].storage;
  return schema.parse(row.value) as OrgSettingStorage<K>;
}

export async function getRawOrgContextTreeSetting(db: Database, orgId: string): Promise<unknown> {
  const [row] = await db
    .select({ value: organizationSettings.value })
    .from(organizationSettings)
    .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, "context_tree")))
    .limit(1);
  return row ? row.value : { branch: "main" };
}

async function lockOrganizationForSettingsMutation(db: Database, orgId: string): Promise<void> {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .for("update")
    .limit(1);
  if (!org) {
    throw new NotFoundError(`Organization "${orgId}" not found`);
  }
}

function emptyStorage<K extends OrgSettingNamespace>(namespace: K): OrgSettingStorage<K> {
  // The storage schema's `.parse({})` fills in any defaults (e.g. context_tree.branch="main").
  const schema = ORG_SETTINGS_NAMESPACES[namespace].storage;
  return schema.parse({}) as OrgSettingStorage<K>;
}

function isCompleteContextTreeReplacement(input: OrgSettingInput<"context_tree">): boolean {
  return input.repo !== undefined && input.branch !== undefined;
}

/**
 * Merge a validated input into the current storage row for a namespace.
 *
 * Input semantics per nullish field:
 *   `undefined` → unchanged
 *   `null`      → cleared
 *   value       → set / replace (already validated as non-empty by the input schema)
 */
function applyInputDelta<K extends OrgSettingNamespace>(
  namespace: K,
  current: OrgSettingStorage<K>,
  input: OrgSettingInput<K>,
): OrgSettingStorage<K> {
  if (namespace === "context_tree") {
    const cur = current as OrgSettingStorage<"context_tree">;
    const inp = input as OrgSettingInput<"context_tree">;
    const next: OrgSettingStorage<"context_tree"> = {
      repo: inp.repo === undefined ? cur.repo : (inp.repo ?? undefined),
      branch: inp.branch === undefined ? cur.branch : (inp.branch ?? "main"),
    };
    return next as OrgSettingStorage<K>;
  }
  if (namespace === "source_repos") {
    const cur = current as OrgSettingStorage<"source_repos">;
    const inp = input as OrgSettingInput<"source_repos">;
    const next: OrgSettingStorage<"source_repos"> = {
      repos: inp.repos === undefined ? cur.repos : inp.repos,
    };
    return next as OrgSettingStorage<K>;
  }
  if (namespace === "context_tree_features") {
    const cur = current as OrgSettingStorage<"context_tree_features">;
    const inp = input as OrgSettingInput<"context_tree_features">;
    const next: OrgSettingStorage<"context_tree_features"> = {
      contextReviewer: {
        enabled: inp.contextReviewer.enabled,
        agentUuid: inp.contextReviewer.enabled ? inp.contextReviewer.agentUuid : null,
        workflow: inp.contextReviewer.workflow ?? cur.contextReviewer.workflow,
        governance: inp.contextReviewer.governance ?? cur.contextReviewer.governance,
        mergeMethod: inp.contextReviewer.mergeMethod ?? cur.contextReviewer.mergeMethod,
      },
    };
    return next as OrgSettingStorage<K>;
  }
  // Exhaustiveness — adding a new namespace forces a compile error here.
  const _exhaustive: never = namespace;
  return _exhaustive;
}

/**
 * Project the storage row into the API output for a namespace, masking
 * any secret fields.
 */
async function toOutput<K extends OrgSettingNamespace>(
  db: Database,
  orgId: string,
  namespace: K,
  storage: OrgSettingStorage<K>,
): Promise<OrgSettingOutput<K>> {
  if (namespace === "context_tree") {
    const s = storage as OrgSettingStorage<"context_tree">;
    const out: OrgSettingOutput<"context_tree"> = {
      repo: s.repo,
      branch: s.branch,
    };
    return out as OrgSettingOutput<K>;
  }
  if (namespace === "source_repos") {
    const s = storage as OrgSettingStorage<"source_repos">;
    const out: OrgSettingOutput<"source_repos"> = {
      repos: s.repos,
    };
    return out as OrgSettingOutput<K>;
  }
  if (namespace === "context_tree_features") {
    const s = storage as OrgSettingStorage<"context_tree_features">;
    const out: OrgSettingOutput<"context_tree_features"> = {
      contextReviewer: {
        enabled: s.contextReviewer.enabled,
        agentUuid: s.contextReviewer.agentUuid,
        workflow: s.contextReviewer.workflow,
        governance: s.contextReviewer.governance,
        mergeMethod: s.contextReviewer.mergeMethod,
        reviewerAgent: await resolveContextReviewerAgentSummary(db, orgId, s.contextReviewer.agentUuid),
      },
    };
    return out as OrgSettingOutput<K>;
  }
  const _exhaustive: never = namespace;
  return _exhaustive;
}

/**
 * Read a setting masked for the API. Missing rows → namespace defaults
 * (parse `{}` against the storage schema).
 */
export async function getOrgSetting<K extends OrgSettingNamespace>(
  db: Database,
  orgId: string,
  namespace: K,
): Promise<OrgSettingOutput<K>> {
  assertNamespace(namespace);
  const storage = (await fetchStorageRow(db, orgId, namespace)) ?? emptyStorage(namespace);
  return toOutput(db, orgId, namespace, storage);
}

/**
 * Read a runtime-safe Context Tree binding for server-internal consumers.
 *
 * The admin-only `/context_tree/raw` settings read preserves loose historical
 * values for repair. Runtime consumers must fail closed: an incomplete or
 * invalid historical row is not an active binding.
 */
export async function getOrgContextTreeBinding(db: Database, orgId: string): Promise<ContextTreeActiveBinding | null> {
  const state = await getOrgContextTreeSettingState(db, orgId);
  return state.kind === "bound" ? state.binding : null;
}

/**
 * Read the stable member-safe projection used by the settings API. Unlike the
 * raw admin repair view, this never returns invalid historical repo or branch
 * values to callers.
 */
export async function getOrgContextTreeSettingState(db: Database, orgId: string): Promise<ContextTreeSettingState> {
  const [row] = await db
    .select({ value: organizationSettings.value })
    .from(organizationSettings)
    .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, "context_tree")))
    .limit(1);
  return classifyContextTreeSetting(row ? row.value : {});
}

/**
 * Read the Context Tree binding plus row freshness. Onboarding recovery uses
 * `updatedAt` to distinguish a tree binding created after the user completed
 * the value-first work chat from an older, already-adopted team tree.
 */
export async function getOrgContextTreeWithMeta(
  db: Database,
  orgId: string,
): Promise<{ binding: ContextTreeActiveBinding | null; updatedAt: Date | null }> {
  const [row] = await db
    .select({ value: organizationSettings.value, updatedAt: organizationSettings.updatedAt })
    .from(organizationSettings)
    .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, "context_tree")))
    .limit(1);
  if (!row) return { binding: null, updatedAt: null };
  const state = classifyContextTreeSetting(row.value);
  return { binding: state.kind === "bound" ? state.binding : null, updatedAt: row.updatedAt };
}

/**
 * Upsert a setting. Returns the masked output of the resulting row.
 *
 * The transaction locks the stable organization parent row before reading the
 * current JSON value. This also serializes writes when the namespace row does
 * not exist yet, so partial updates cannot lose each other's fields.
 */
export async function putOrgSetting<K extends OrgSettingNamespace>(
  db: Database,
  orgId: string,
  namespace: K,
  rawInput: unknown,
  options: { updatedBy: string; memberId?: string },
): Promise<OrgSettingOutput<K>> {
  assertNamespace(namespace);

  const inputSchema = ORG_SETTINGS_NAMESPACES[namespace].input;
  const input = inputSchema.parse(rawInput) as OrgSettingInput<K>;

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockOrganizationForSettingsMutation(txDb, orgId);

    let current: OrgSettingStorage<K>;
    if (namespace === "context_tree") {
      const rawCurrent = await getRawOrgContextTreeSetting(txDb, orgId);
      const parsedCurrent = ORG_SETTINGS_NAMESPACES.context_tree.storage.safeParse(rawCurrent);
      const contextTreeInput = input as OrgSettingInput<"context_tree">;
      if (!parsedCurrent.success && !isCompleteContextTreeReplacement(contextTreeInput)) {
        // A partial update cannot safely preserve fields from malformed JSON.
        // Re-throw the storage error without changing the historical row.
        throw parsedCurrent.error;
      }
      current = (parsedCurrent.success ? parsedCurrent.data : emptyStorage("context_tree")) as OrgSettingStorage<K>;
    } else {
      current = (await fetchStorageRow(txDb, orgId, namespace)) ?? emptyStorage(namespace);
    }
    const merged = applyInputDelta(namespace, current, input);

    // Final shape check (defensive — should always pass after applyInputDelta).
    const storageSchema = ORG_SETTINGS_NAMESPACES[namespace].storage;
    const validated = storageSchema.parse(merged) as OrgSettingStorage<K>;
    if (namespace === "context_tree_features") {
      await assertContextReviewerAgentAllowed(
        txDb,
        orgId,
        validated as OrgContextTreeFeaturesStorage,
        options.memberId,
      );
    }
    if (namespace === "context_tree") {
      const contextTree = validated as OrgContextTreeStorage;
      if (contextTree.repo === undefined) {
        contextTreeBranchSchema.parse(contextTree.branch);
      } else {
        contextTreeActiveBindingSchema.parse(contextTree);
      }
    }

    await tx
      .insert(organizationSettings)
      .values({
        organizationId: orgId,
        namespace,
        value: validated as Record<string, unknown>,
        version: 1,
        updatedBy: options.updatedBy,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [organizationSettings.organizationId, organizationSettings.namespace],
        set: {
          value: validated as Record<string, unknown>,
          version: sql`${organizationSettings.version} + 1`,
          updatedBy: options.updatedBy,
          updatedAt: new Date(),
        },
      });

    return toOutput(txDb, orgId, namespace, validated);
  });
}

/**
 * Persist an initialized Context Tree binding only while the exact unbound
 * branch observed by the caller is still current. Callers can perform external
 * work between observation and finalization, so this conditional write is the
 * authoritative concurrency guard.
 *
 * Every regular settings mutation takes the same organization-row lock. The
 * `setWhere` predicate also protects against a writer that bypasses this
 * service: PostgreSQL returns no row when a concurrent value gains a repo or
 * changes the unbound branch observed by the early route check.
 */
export async function putInitializedOrgContextTreeBinding(
  db: Database,
  orgId: string,
  rawInput: unknown,
  options: { updatedBy: string; expectedUnboundBranch: string },
): Promise<ContextTreeActiveBinding> {
  const binding = contextTreeActiveBindingSchema.parse(rawInput);
  const expectedUnboundBranch = contextTreeBranchSchema.parse(options.expectedUnboundBranch);
  const value: Record<string, unknown> = { repo: binding.repo, branch: binding.branch };

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockOrganizationForSettingsMutation(txDb, orgId);
    const current = await getOrgContextTreeSettingState(txDb, orgId);
    if (current.kind !== "unbound" || current.branch !== expectedUnboundBranch) {
      throw new ConflictError("Context Tree setting changed after tree initialization began");
    }
    const now = new Date();

    const [row] = await tx
      .insert(organizationSettings)
      .values({
        organizationId: orgId,
        namespace: "context_tree",
        value,
        version: 1,
        updatedBy: options.updatedBy,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [organizationSettings.organizationId, organizationSettings.namespace],
        set: {
          value,
          version: sql`${organizationSettings.version} + 1`,
          updatedBy: options.updatedBy,
          updatedAt: now,
        },
        setWhere: sql`
          jsonb_typeof(${organizationSettings.value}) = 'object'
          AND NOT (${organizationSettings.value} ? 'repo')
          AND (
            (
              jsonb_typeof(${organizationSettings.value} -> 'branch') = 'string'
              AND ${organizationSettings.value} ->> 'branch' = ${expectedUnboundBranch}
            )
            OR (
              NOT (${organizationSettings.value} ? 'branch')
              AND ${expectedUnboundBranch} = 'main'
            )
          )
        `,
      })
      .returning({ value: organizationSettings.value });

    if (!row) {
      throw new ConflictError("Context Tree setting changed after tree initialization began");
    }
    return contextTreeActiveBindingSchema.parse(row.value);
  });
}

async function resolveContextReviewerAgentSummary(
  db: Database,
  orgId: string,
  agentUuid: string | null,
): Promise<{ uuid: string; name: string | null; displayName: string } | null> {
  if (!agentUuid) return null;
  const [agent] = await db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      displayName: agents.displayName,
    })
    .from(agents)
    .where(and(eq(agents.uuid, agentUuid), eq(agents.organizationId, orgId), ne(agents.status, "deleted")))
    .limit(1);
  return agent ?? null;
}

async function assertContextReviewerAgentAllowed(
  db: Database,
  orgId: string,
  input: OrgContextTreeFeaturesStorage,
  memberId: string | undefined,
): Promise<void> {
  if (!input.contextReviewer.enabled) return;
  if (!memberId) {
    throw new ForbiddenError("Context Reviewer can only be assigned by an active member of this organization");
  }
  const agentUuid = input.contextReviewer.agentUuid;
  if (!agentUuid) {
    throw new BadRequestError("agentUuid is required when Context Reviewer is enabled");
  }

  const [agent] = await db
    .select({
      uuid: agents.uuid,
      type: agents.type,
      status: agents.status,
      organizationId: agents.organizationId,
    })
    .from(agents)
    .where(eq(agents.uuid, agentUuid))
    .limit(1);

  if (!agent || agent.organizationId !== orgId || agent.type === "human" || agent.status !== "active") {
    throw new BadRequestError("Context Reviewer agent must be an active non-human agent in this organization");
  }

  if (input.contextReviewer.workflow === "agent_review") return;

  const installation = await findInstallationByOrg(db, orgId);
  if (!installation) {
    throw new BadRequestError("Connect this team's GitHub App installation before enabling Context Reviewer");
  }
  if (installation.suspendedAt) {
    throw new BadRequestError("Unsuspend this team's GitHub App installation before enabling Context Reviewer");
  }
  if (installation.permissions.pull_requests !== "write") {
    throw new BadRequestError(
      "The GitHub App installation owner must accept Pull requests: write before enabling Context Reviewer",
    );
  }
}

/**
 * Delete a namespace row; subsequent GETs return defaults.
 */
export async function deleteOrgSetting(db: Database, orgId: string, namespace: string): Promise<void> {
  assertNamespace(namespace);
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockOrganizationForSettingsMutation(txDb, orgId);
    await tx
      .delete(organizationSettings)
      .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, namespace)));
  });
}

/**
 * Resolve the caller's "primary org" for user-scoped routes that
 * historically didn't take an `:orgId` (e.g. `/context-tree/info`,
 * `/context-tree/snapshot`).
 *
 * Uses the same `pickDefaultMembership` helper that `/me` uses to compute
 * `defaultOrganizationId` (most-recently-active membership, id desc tie-break).
 * That guarantees the org `/me` reports as the default is the same org these
 * server-internal lookups read from — earlier the two sides used opposite
 * orderings (`/me` desc, this fn asc), so multi-org users saw `/info`
 * resolve to a different (often unconfigured) org than the one Team Settings
 * was edited for.
 *
 * Returns `null` for users with no active membership.
 */
export async function resolveUserPrimaryOrgId(db: Database, userId: string): Promise<string | null> {
  const rows = await db
    .select({
      id: members.id,
      organizationId: members.organizationId,
      createdAt: members.createdAt,
    })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.status, "active")));
  return pickDefaultMembership(rows)?.organizationId ?? null;
}
