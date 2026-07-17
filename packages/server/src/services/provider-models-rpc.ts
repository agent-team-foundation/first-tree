import { type ProviderModelCatalog, providerModelCatalogSchema } from "@first-tree/shared";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { clients } from "../db/schema/clients.js";

/**
 * Durable rendezvous for host-local model-catalog RPC.
 *
 * PG NOTIFY payloads must stay small (≈8KB). Cursor catalogs can exceed that,
 * so the socket-owning replica stores the catalog under
 * `clients.metadata.modelCatalogRpc[ref]` with an atomic top-level `jsonb_set`
 * (sibling keys like `capabilities` stay intact) and a nested `||` merge for
 * the ref (concurrent UPDATEs on the same client row serialize under the row
 * lock and re-read the latest map). A tiny `{ clientId, ref }` wake fans out
 * after the durable write.
 */

const RPC_METADATA_KEY = "modelCatalogRpc";
/** Ignore durable entries older than this (logical TTL; keys are not rewritten). */
const MAX_AGE_MS = 120_000;
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
  if (!Number.isFinite(storedMs) || Date.now() - storedMs >= MAX_AGE_MS) return null;
  return { catalog: parsed.data, storedAt: row.storedAt };
}

/**
 * Persist one catalog ref without replacing the whole `clients.metadata` object.
 * Concurrent refs and sibling metadata writers (capabilities) are preserved.
 */
export async function storeModelCatalogRpcResult(
  db: Database,
  clientId: string,
  ref: string,
  catalog: ProviderModelCatalog,
): Promise<void> {
  if (!REF_RE.test(ref)) {
    throw new Error(`Invalid model-catalog RPC ref: ${ref}`);
  }
  const entry = {
    catalog,
    storedAt: new Date().toISOString(),
  };
  // Top-level jsonb_set keeps capabilities / lastUpdateAttempt. Nested || merges
  // one ref; concurrent UPDATEs on this row serialize and re-evaluate against
  // the latest map under READ COMMITTED.
  await db
    .update(clients)
    .set({
      metadata: sql`jsonb_set(
        COALESCE(${clients.metadata}, '{}'::jsonb),
        '{modelCatalogRpc}',
        COALESCE(${clients.metadata} -> 'modelCatalogRpc', '{}'::jsonb)
          || jsonb_build_object(${ref}::text, ${JSON.stringify(entry)}::jsonb),
        true
      )`,
    })
    .where(eq(clients.id, clientId));
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

/**
 * True when the DB says a daemon WebSocket is live somewhere (this process or
 * another replica). Used to decide between cross-replica fan-out and a hard 503.
 */
export function isClientConnectedSomewhere(client: { status: string; instanceId: string | null }): boolean {
  return client.status === "connected" && client.instanceId != null;
}
