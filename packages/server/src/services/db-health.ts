import { sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";

/**
 * Process-local cached database health probe shared by `/healthz`'s siblings
 * (`/readyz`, `/api/v1/health`). Caps DB probing at one `SELECT 1` per TTL
 * window per process regardless of external request rate, so public health
 * traffic can never be amplified into PG load (issue #1716).
 *
 * Concurrency contract:
 *   - Results (success AND failure) are cached for TTL_MS; callers inside the
 *     window are answered from memory without touching the DB.
 *   - Single-flight: at most one probe is ever pending. The in-flight slot is
 *     released only when the underlying probe settles — callers arriving in
 *     later TTL windows while a probe hangs (postgres-js connect_timeout can
 *     hold it for ~30s) await the same probe instead of spawning another.
 *   - Each caller races the shared probe against its own PROBE_TIMEOUT_MS
 *     budget. On timeout the caller records a failure in the cache and
 *     returns, but does not cancel the probe or release the slot; when the
 *     probe eventually settles, its real result overwrites the cache
 *     (last-write-wins) and the slot clears.
 */

/** How long a probe result (success or failure) is served from cache. */
const TTL_MS = 5_000;

/**
 * Per-caller budget to wait on the shared probe before reporting failure.
 * Kept below Docker HEALTHCHECK `--timeout=5s` and the CLI doctor's 3s fetch
 * timeout so probes receive a definite 503 instead of timing out client-side.
 */
const PROBE_TIMEOUT_MS = 2_000;

export type DbHealthResult = {
  ok: boolean;
  /** ISO timestamp of when this result was recorded (probe settle or caller timeout). */
  checkedAt: string;
  /** Time for the probe to settle. Absent when the entry was recorded by a caller timeout. */
  latencyMs?: number;
};

export type DbHealthChecker = { check: () => Promise<DbHealthResult> };

export function createDbHealthChecker(
  db: Database,
  opts: { ttlMs?: number; timeoutMs?: number } = {},
): DbHealthChecker {
  const ttlMs = opts.ttlMs ?? TTL_MS;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;

  let cached: { result: DbHealthResult; expiresAt: number } | null = null;
  let inFlight: Promise<DbHealthResult> | null = null;

  function record(result: DbHealthResult): DbHealthResult {
    cached = { result, expiresAt: Date.now() + ttlMs };
    return result;
  }

  async function probe(): Promise<DbHealthResult> {
    const startedAt = Date.now();
    let ok: boolean;
    try {
      await db.execute(sql`SELECT 1`);
      ok = true;
    } catch {
      ok = false;
    }
    inFlight = null;
    return record({ ok, checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt });
  }

  async function check(): Promise<DbHealthResult> {
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    inFlight ??= probe();

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        inFlight,
        new Promise<DbHealthResult>((resolve) => {
          timer = setTimeout(() => {
            resolve(record({ ok: false, checkedAt: new Date().toISOString() }));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { check };
}
