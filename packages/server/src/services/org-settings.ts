import {
  isOrgSettingNamespace,
  ORG_SETTINGS_NAMESPACES,
  type OrgContextTreeStorage,
  type OrgSettingInput,
  type OrgSettingNamespace,
  type OrgSettingOutput,
  type OrgSettingStorage,
} from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError, NotFoundError } from "../errors.js";
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
  // Exhaustiveness — adding a new namespace forces a compile error here.
  const _exhaustive: never = namespace;
  return _exhaustive;
}

/**
 * Project the storage row into the API output for a namespace, masking
 * any secret fields.
 */
function toOutput<K extends OrgSettingNamespace>(namespace: K, storage: OrgSettingStorage<K>): OrgSettingOutput<K> {
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
  return toOutput(namespace, storage);
}

/**
 * Read the per-org Context Tree binding for server-internal consumers
 * (`/context-tree/info`, snapshot service). No secrets in this namespace,
 * so the storage shape is safe to expose directly. Missing row → defaults.
 */
export async function getOrgContextTree(db: Database, orgId: string): Promise<OrgContextTreeStorage> {
  return (await fetchStorageRow(db, orgId, "context_tree")) ?? emptyStorage("context_tree");
}

/**
 * Upsert a setting. Returns the masked output of the resulting row.
 *
 * The fetch + merge + upsert sequence runs inside a single transaction so
 * two concurrent admin writes can't both base their delta on the same
 * pre-image and silently lose each other's fields. Optimistic locking
 * (the `version` column) remains reserved for a future If-Match flip.
 * (#6)
 */
export async function putOrgSetting<K extends OrgSettingNamespace>(
  db: Database,
  orgId: string,
  namespace: K,
  rawInput: unknown,
  options: { updatedBy: string },
): Promise<OrgSettingOutput<K>> {
  assertNamespace(namespace);

  const inputSchema = ORG_SETTINGS_NAMESPACES[namespace].input;
  const input = inputSchema.parse(rawInput) as OrgSettingInput<K>;

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const [org] = await txDb
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) {
      throw new NotFoundError(`Organization "${orgId}" not found`);
    }

    const current = (await fetchStorageRow(txDb, orgId, namespace)) ?? emptyStorage(namespace);
    const merged = applyInputDelta(namespace, current, input);

    // Final shape check (defensive — should always pass after applyInputDelta).
    const storageSchema = ORG_SETTINGS_NAMESPACES[namespace].storage;
    const validated = storageSchema.parse(merged) as OrgSettingStorage<K>;

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

    return toOutput(namespace, validated);
  });
}

/**
 * Delete a namespace row; subsequent GETs return defaults.
 */
export async function deleteOrgSetting(db: Database, orgId: string, namespace: string): Promise<void> {
  assertNamespace(namespace);
  await db
    .delete(organizationSettings)
    .where(and(eq(organizationSettings.organizationId, orgId), eq(organizationSettings.namespace, namespace)));
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
