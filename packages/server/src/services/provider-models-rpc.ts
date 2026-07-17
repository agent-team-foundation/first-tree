import { type ProviderModelCatalog, providerModelCatalogSchema } from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { clients } from "../db/schema/clients.js";

/**
 * Durable rendezvous for host-local model-catalog RPC.
 *
 * PG NOTIFY payloads must stay small (≈8KB). Cursor catalogs can exceed that,
 * so the socket-owning replica stores the catalog under
 * `clients.metadata.modelCatalogRpc[ref]` with an atomic top-level `jsonb_set`
 * (sibling keys like `capabilities` stay intact), a nested merge for the ref,
 * and physical prune of aged/excess entries in the same UPDATE. Ownership is
 * enforced in that UPDATE (`id` + expected `instance_id`) so a takeover between
 * check and write cannot persist.
 */

const RPC_METADATA_KEY = "modelCatalogRpc";

/** Physical TTL for rendezvous entries (also applied on read). */
export const MODEL_CATALOG_RPC_MAX_AGE_MS = 120_000;
/** Cap on retained refs per client after each successful store. */
export const MODEL_CATALOG_RPC_MAX_ENTRIES = 20;

const REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RpcEntry = {
  catalog: ProviderModelCatalog;
  storedAt: string;
};

function asRpcEntry(raw: unknown): RpcEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const parsed = providerModelCatalogSchema.safeParse(row.catalog);
  if (!parsed.success || typeof row.storedAt !== "string") return null;
  const storedMs = Date.parse(row.storedAt);
  if (!Number.isFinite(storedMs) || Date.now() - storedMs >= MODEL_CATALOG_RPC_MAX_AGE_MS) return null;
  return { catalog: parsed.data, storedAt: row.storedAt };
}

/**
 * Persist one catalog ref iff this replica still owns the client row.
 * Returns false when `instance_id` no longer matches (takeover) or the row is gone.
 * Physically prunes aged/excess refs in the same statement.
 */
export async function storeModelCatalogRpcResult(
  db: Database,
  clientId: string,
  ref: string,
  catalog: ProviderModelCatalog,
  expectedInstanceId: string,
): Promise<boolean> {
  if (!REF_RE.test(ref)) {
    throw new Error(`Invalid model-catalog RPC ref: ${ref}`);
  }
  const entry = {
    catalog,
    storedAt: new Date().toISOString(),
  };
  const maxAgeSeconds = Math.floor(MODEL_CATALOG_RPC_MAX_AGE_MS / 1000);
  // One UPDATE: ownership guard + merge ref + physical prune (age then newest N).
  // Column refs in SET are the pre-update row; concurrent UPDATEs serialize on the row.
  const returned = await db
    .update(clients)
    .set({
      metadata: sql`jsonb_set(
        COALESCE(${clients.metadata}, '{}'::jsonb),
        '{modelCatalogRpc}',
        (
          SELECT COALESCE(jsonb_object_agg(kept.key, kept.value), '{}'::jsonb)
          FROM (
            SELECT e.key, e.value
            FROM jsonb_each(
              COALESCE(${clients.metadata} -> 'modelCatalogRpc', '{}'::jsonb)
              || jsonb_build_object(${ref}::text, ${JSON.stringify(entry)}::jsonb)
            ) AS e(key, value)
            WHERE COALESCE((e.value->>'storedAt')::timestamptz, '-infinity'::timestamptz)
              > now() - make_interval(secs => ${maxAgeSeconds})
            ORDER BY (e.value->>'storedAt')::timestamptz DESC NULLS LAST
            LIMIT ${MODEL_CATALOG_RPC_MAX_ENTRIES}
          ) AS kept
        ),
        true
      )`,
    })
    .where(and(eq(clients.id, clientId), eq(clients.instanceId, expectedInstanceId)))
    .returning({ id: clients.id });
  return returned.length > 0;
}

/** Load a previously stored catalog when still within the logical TTL. */
export async function readModelCatalogRpcResult(
  db: Database,
  clientId: string,
  ref: string,
): Promise<ProviderModelCatalog | null> {
  const [client] = await db
    .select({ metadata: clients.metadata })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) return null;
  const base = (client.metadata ?? {}) as Record<string, unknown>;
  const map = base[RPC_METADATA_KEY];
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const entry = asRpcEntry((map as Record<string, unknown>)[ref]);
  return entry?.catalog ?? null;
}

/** Raw rendezvous key count (including aged entries) — test/observability seam. */
export async function countModelCatalogRpcKeys(db: Database, clientId: string): Promise<number> {
  const [client] = await db
    .select({ metadata: clients.metadata })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client?.metadata || typeof client.metadata !== "object") return 0;
  const map = (client.metadata as Record<string, unknown>)[RPC_METADATA_KEY];
  if (!map || typeof map !== "object" || Array.isArray(map)) return 0;
  return Object.keys(map as Record<string, unknown>).length;
}

/**
 * True when the DB says a daemon WebSocket is live somewhere (this process or
 * another replica). Used to decide between cross-replica fan-out and a hard fail.
 */
export function isClientConnectedSomewhere(client: { status: string; instanceId: string | null }): boolean {
  return client.status === "connected" && client.instanceId != null;
}
