import {
  type ContextTreeActiveBinding,
  contextTreeActiveBindingSchema,
  isOrgSettingNamespace,
  ORG_SETTINGS_NAMESPACES,
  type OrgContextTreeFeaturesInput,
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
    const inp = input as OrgSettingInput<"context_tree_features">;
    const next: OrgSettingStorage<"context_tree_features"> = {
      contextReviewer: {
        enabled: inp.contextReviewer.enabled,
        agentUuid: inp.contextReviewer.enabled ? inp.contextReviewer.agentUuid : null,
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
 * The generic settings read intentionally preserves loose historical values so
 * an administrator can see and repair them. Runtime consumers must fail closed:
 * an incomplete or invalid historical row is not an active binding.
 */
export async function getOrgContextTreeBinding(db: Database, orgId: string): Promise<ContextTreeActiveBinding | null> {
  const storage = await fetchStorageRow(db, orgId, "context_tree");
  if (!storage) return null;
  const parsed = contextTreeActiveBindingSchema.safeParse(storage);
  return parsed.success ? parsed.data : null;
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
  const storage = ORG_SETTINGS_NAMESPACES.context_tree.storage.parse(row.value) as OrgContextTreeStorage;
  const parsed = contextTreeActiveBindingSchema.safeParse(storage);
  return { binding: parsed.success ? parsed.data : null, updatedAt: row.updatedAt };
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

    const current = (await fetchStorageRow(txDb, orgId, namespace)) ?? emptyStorage(namespace);
    const merged = applyInputDelta(namespace, current, input);
    if (namespace === "context_tree_features") {
      await assertContextReviewerAgentAllowed(txDb, orgId, input as OrgContextTreeFeaturesInput, options.memberId);
    }

    // Final shape check (defensive — should always pass after applyInputDelta).
    const storageSchema = ORG_SETTINGS_NAMESPACES[namespace].storage;
    const validated = storageSchema.parse(merged) as OrgSettingStorage<K>;
    if (namespace === "context_tree") {
      const contextTree = validated as OrgContextTreeStorage;
      if (contextTree.repo !== undefined) {
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
 * Persist an initialized Context Tree binding only if no repo was bound after
 * initialization began. GitHub side effects happen outside this transaction,
 * so the final write must re-check under the same organization settings lock
 * used by regular settings writes.
 */
export async function putInitializedOrgContextTreeBinding(
  db: Database,
  orgId: string,
  rawInput: unknown,
  options: { updatedBy: string },
): Promise<OrgSettingOutput<"context_tree">> {
  const input = ORG_SETTINGS_NAMESPACES.context_tree.input.parse(rawInput) as OrgSettingInput<"context_tree">;

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockOrganizationForSettingsMutation(txDb, orgId);

    const current = (await fetchStorageRow(txDb, orgId, "context_tree")) ?? emptyStorage("context_tree");
    if (current.repo !== undefined) {
      throw new ConflictError("Context Tree repo is already configured for this team");
    }

    const merged = applyInputDelta("context_tree", current, input);
    const validated = ORG_SETTINGS_NAMESPACES.context_tree.storage.parse(merged) as OrgContextTreeStorage;
    contextTreeActiveBindingSchema.parse(validated);

    await tx
      .insert(organizationSettings)
      .values({
        organizationId: orgId,
        namespace: "context_tree",
        value: validated,
        version: 1,
        updatedBy: options.updatedBy,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [organizationSettings.organizationId, organizationSettings.namespace],
        set: {
          value: validated,
          version: sql`${organizationSettings.version} + 1`,
          updatedBy: options.updatedBy,
          updatedAt: new Date(),
        },
      });

    return toOutput(txDb, orgId, "context_tree", validated);
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
  input: OrgContextTreeFeaturesInput,
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
