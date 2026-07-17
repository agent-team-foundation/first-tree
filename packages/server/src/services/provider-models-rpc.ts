import { type ProviderModelCatalog, providerModelCatalogSchema } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { clients } from "../db/schema/clients.js";

/**
 * Durable rendezvous for host-local model-catalog RPC.
 *
 * PG NOTIFY payloads must stay small (≈8KB). Cursor catalogs can exceed that,
 * so the socket-owning replica stores the catalog under
 * `clients.metadata.modelCatalogRpc[ref]` and fans a tiny `{ clientId, ref }`
 * wake. The HTTP-serving replica (possibly a different process) loads the
 * catalog from metadata and resolves its local waiter.
 */

const RPC_METADATA_KEY = "modelCatalogRpc";
const MAX_AGE_MS = 120_000;
const MAX_ENTRIES = 20;

type RpcEntry = {
  catalog: ProviderModelCatalog;
  storedAt: string;
};

function asRpcMap(raw: unknown): Record<string, RpcEntry> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, RpcEntry> = {};
  for (const [ref, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const parsed = providerModelCatalogSchema.safeParse(row.catalog);
    if (!parsed.success || typeof row.storedAt !== "string") continue;
    out[ref] = { catalog: parsed.data, storedAt: row.storedAt };
  }
  return out;
}

function pruneRpcMap(map: Record<string, RpcEntry>, nowMs: number): Record<string, RpcEntry> {
  const fresh = Object.entries(map).filter(([, entry]) => {
    const t = Date.parse(entry.storedAt);
    return Number.isFinite(t) && nowMs - t < MAX_AGE_MS;
  });
  fresh.sort((a, b) => Date.parse(b[1].storedAt) - Date.parse(a[1].storedAt));
  return Object.fromEntries(fresh.slice(0, MAX_ENTRIES));
}

/** Persist a catalog so any replica can resolve the correlated HTTP waiter. */
export async function storeModelCatalogRpcResult(
  db: Database,
  clientId: string,
  ref: string,
  catalog: ProviderModelCatalog,
): Promise<void> {
  const [client] = await db
    .select({ metadata: clients.metadata })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) return;

  const base = (client.metadata ?? {}) as Record<string, unknown>;
  const existing = asRpcMap(base[RPC_METADATA_KEY]);
  const now = new Date();
  const next = pruneRpcMap(
    {
      ...existing,
      [ref]: { catalog, storedAt: now.toISOString() },
    },
    now.getTime(),
  );
  await db
    .update(clients)
    .set({ metadata: { ...base, [RPC_METADATA_KEY]: next } })
    .where(eq(clients.id, clientId));
}

/** Load a previously stored catalog (does not delete — prune happens on write). */
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
  const entry = asRpcMap(base[RPC_METADATA_KEY])[ref];
  return entry?.catalog ?? null;
}

/**
 * True when the DB says a daemon WebSocket is live somewhere (this process or
 * another replica). Used after a local `sendToClient` miss to decide between
 * cross-replica fan-out and a hard 503.
 */
export function isClientConnectedSomewhere(client: { status: string; instanceId: string | null }): boolean {
  return client.status === "connected" && client.instanceId != null;
}
