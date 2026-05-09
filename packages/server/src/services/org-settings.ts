import {
  isOrgSettingNamespace,
  ORG_SETTINGS_NAMESPACES,
  type OrgContextTreeStorage,
  type OrgSettingInput,
  type OrgSettingNamespace,
  type OrgSettingOutput,
  type OrgSettingStorage,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { decryptValue, encryptValue, isEncryptedValue } from "./crypto.js";

/**
 * Per-organization settings, keyed by `(organizationId, namespace)`. The
 * registry of valid namespaces and their storage / input / output schemas
 * lives in `@agent-team-foundation/first-tree-hub-shared`.
 *
 * Read path:  storage row → decrypt secrets → output (mask)
 * Write path: input → validate → encrypt secrets → merge with current storage → upsert (in tx)
 *
 * The generic getter returns the masked output. Callers needing plaintext
 * for a specific secret use a purpose-built helper (e.g.
 * `getDecryptedGithubWebhookSecret`) rather than the generic storage shape
 * — this avoids a `…Cipher` field name silently holding plaintext at
 * call-sites and limits secret exposure to one explicit code path per
 * secret. (#4)
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

function ensureEncrypted(value: string, encryptionKey: string): string {
  return isEncryptedValue(value) ? value : encryptValue(value, encryptionKey);
}

/**
 * Merge a validated input into the current storage row for a namespace.
 * Secret fields are encrypted here.
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
  encryptionKey: string,
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
  if (namespace === "github_integration") {
    const cur = current as OrgSettingStorage<"github_integration">;
    const inp = input as OrgSettingInput<"github_integration">;
    const next: OrgSettingStorage<"github_integration"> = {
      webhookSecretCipher:
        inp.webhookSecret === undefined
          ? cur.webhookSecretCipher
          : inp.webhookSecret === null
            ? undefined
            : ensureEncrypted(inp.webhookSecret, encryptionKey),
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
 * any secret fields. `webhookUrl` for `github_integration` is left as an
 * empty string here — the route layer enriches it with the resolved
 * `server.publicUrl` (the service stays config-agnostic).
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
  if (namespace === "github_integration") {
    const s = storage as OrgSettingStorage<"github_integration">;
    const out: OrgSettingOutput<"github_integration"> = {
      webhookSecretConfigured: typeof s.webhookSecretCipher === "string" && s.webhookSecretCipher.length > 0,
      webhookUrl: "",
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
 * Decrypt and return the plaintext GitHub webhook secret for an org.
 * Returns `null` when the org has not configured one. The only intended
 * caller is the webhook route's signature verifier — the result must
 * never leak through HTTP responses or logs. (#4)
 */
export async function getDecryptedGithubWebhookSecret(
  db: Database,
  orgId: string,
  encryptionKey: string,
): Promise<string | null> {
  const storage = await fetchStorageRow(db, orgId, "github_integration");
  const cipher = storage?.webhookSecretCipher;
  if (!cipher) return null;
  return isEncryptedValue(cipher) ? decryptValue(cipher, encryptionKey) : cipher;
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
  options: { updatedBy: string; encryptionKey: string },
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
    const merged = applyInputDelta(namespace, current, input, options.encryptionKey);

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
 * Resolve the caller's "primary org" — the earliest-joined active
 * membership for the given user. Used by user-scoped routes that
 * historically didn't take an `:orgId` (e.g. `/context-tree/info`) so
 * the SDK call shape doesn't have to change while the per-tenant lookup
 * still happens correctly.
 *
 * Returns `null` for users with no active membership. Tightening to
 * "explicit org selector" is a future change-once-multi-org-clients-arrive
 * concern. (#7)
 */
export async function resolveUserPrimaryOrgId(db: Database, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: members.organizationId })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.status, "active")))
    .orderBy(asc(members.createdAt))
    .limit(1);
  return row?.organizationId ?? null;
}
