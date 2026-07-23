import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import * as eventDedup from "../services/event-dedup.js";
import { useTestApp } from "./helpers.js";

async function readClaim(
  db: Database,
  eventId: string,
  platform: string,
): Promise<{ status: string; expires_at: string | Date | null } | null> {
  const rows = await db.execute<{ status: string; expires_at: string | Date | null }>(
    sql`SELECT status, expires_at FROM processed_events WHERE event_id = ${eventId} AND platform = ${platform}`,
  );
  return rows[0] ?? null;
}

describe("Event deduplication", () => {
  const getApp = useTestApp();

  it("claims an event the first time as a pending claim with an expiry", async () => {
    const app = getApp();
    const claimed = await eventDedup.claimEvent(app.db, "evt_unique_1", "github");
    expect(claimed).toBe(true);
    const row = await readClaim(app.db, "evt_unique_1", "github");
    expect(row?.status).toBe("pending");
    expect(row?.expires_at).not.toBeNull();
  });

  it("rejects a duplicate while an unexpired pending claim is in flight", async () => {
    const app = getApp();
    await eventDedup.claimEvent(app.db, "evt_dup_1", "github");
    const duplicate = await eventDedup.claimEvent(app.db, "evt_dup_1", "github");
    expect(duplicate).toBe(false);
  });

  it("allows same event_id on different platforms", async () => {
    const app = getApp();
    const r1 = await eventDedup.claimEvent(app.db, "evt_cross_1", "github");
    const r2 = await eventDedup.claimEvent(app.db, "evt_cross_1", "other");
    expect(r1).toBe(true);
    expect(r2).toBe(true);
  });

  it("unclaimEvent allows a re-claim", async () => {
    const app = getApp();
    await eventDedup.claimEvent(app.db, "evt_unclaim_1", "github");
    await eventDedup.unclaimEvent(app.db, "evt_unclaim_1", "github");
    const reclaimed = await eventDedup.claimEvent(app.db, "evt_unclaim_1", "github");
    expect(reclaimed).toBe(true);
  });

  it("completeEvent flips the claim to done and dedupes permanently", async () => {
    const app = getApp();
    await eventDedup.claimEvent(app.db, "evt_done_1", "github");
    const completed = await eventDedup.completeEvent(app.db, "evt_done_1", "github");
    expect(completed).toBe(true);
    const row = await readClaim(app.db, "evt_done_1", "github");
    expect(row?.status).toBe("done");
    expect(row?.expires_at).toBeNull();
    // A done claim is never taken over, no matter how long ago it landed.
    expect(await eventDedup.claimEvent(app.db, "evt_done_1", "github")).toBe(false);
    expect(await eventDedup.claimEvent(app.db, "evt_done_1", "github", 0)).toBe(false);
  });

  it("completeEvent returns false when no pending claim exists", async () => {
    const app = getApp();
    expect(await eventDedup.completeEvent(app.db, "evt_missing_1", "github")).toBe(false);
    await eventDedup.claimEvent(app.db, "evt_done_twice_1", "github");
    expect(await eventDedup.completeEvent(app.db, "evt_done_twice_1", "github")).toBe(true);
    expect(await eventDedup.completeEvent(app.db, "evt_done_twice_1", "github")).toBe(false);
  });

  it("takes over an expired pending claim (crashed processor) and renews it", async () => {
    const app = getApp();
    // TTL 0 → the claim is expired the moment it lands, like a claim whose
    // processor crashed before completing or unclaiming and whose TTL passed.
    expect(await eventDedup.claimEvent(app.db, "evt_expired_1", "github", 0)).toBe(true);
    const retaken = await eventDedup.claimEvent(app.db, "evt_expired_1", "github");
    expect(retaken).toBe(true);
    const row = await readClaim(app.db, "evt_expired_1", "github");
    expect(row?.status).toBe("pending");
    // The takeover renewed the expiry, so a third delivery is deduped again.
    expect(await eventDedup.claimEvent(app.db, "evt_expired_1", "github")).toBe(false);
  });

  it("unclaimEvent never deletes a done claim", async () => {
    const app = getApp();
    await eventDedup.claimEvent(app.db, "evt_keep_done_1", "github");
    await eventDedup.completeEvent(app.db, "evt_keep_done_1", "github");
    await eventDedup.unclaimEvent(app.db, "evt_keep_done_1", "github");
    const row = await readClaim(app.db, "evt_keep_done_1", "github");
    expect(row?.status).toBe("done");
    expect(await eventDedup.claimEvent(app.db, "evt_keep_done_1", "github")).toBe(false);
  });

  it("sweeps only expired pending claims", async () => {
    const app = getApp();
    await eventDedup.claimEvent(app.db, "evt_sweep_expired_1", "github", 0);
    await eventDedup.claimEvent(app.db, "evt_sweep_inflight_1", "github");
    await eventDedup.claimEvent(app.db, "evt_sweep_done_1", "github");
    await eventDedup.completeEvent(app.db, "evt_sweep_done_1", "github");

    const swept = await eventDedup.sweepExpiredEventClaims(app.db);

    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await readClaim(app.db, "evt_sweep_expired_1", "github")).toBeNull();
    expect((await readClaim(app.db, "evt_sweep_inflight_1", "github"))?.status).toBe("pending");
    expect((await readClaim(app.db, "evt_sweep_done_1", "github"))?.status).toBe("done");
    // The swept id is claimable again; the in-flight and done ids are not.
    expect(await eventDedup.claimEvent(app.db, "evt_sweep_expired_1", "github")).toBe(true);
    expect(await eventDedup.claimEvent(app.db, "evt_sweep_inflight_1", "github")).toBe(false);
    expect(await eventDedup.claimEvent(app.db, "evt_sweep_done_1", "github")).toBe(false);
  });

  it("grants exactly one claim to concurrent deliveries of a fresh id", async () => {
    const app = getApp();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => eventDedup.claimEvent(app.db, "evt_race_fresh_1", "github")),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("grants exactly one takeover to concurrent deliveries of an expired pending id", async () => {
    const app = getApp();
    await eventDedup.claimEvent(app.db, "evt_race_expired_1", "github", 0);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => eventDedup.claimEvent(app.db, "evt_race_expired_1", "github")),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
