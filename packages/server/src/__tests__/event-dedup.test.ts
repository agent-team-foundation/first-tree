import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { processedEvents } from "../db/schema/processed-events.js";
import * as eventDedup from "../services/event-dedup.js";
import { CLAIM_TTL_MS } from "../services/event-dedup.js";
import { useTestApp } from "./helpers.js";

/** Push a claim's expiry into the past, simulating a claim whose TTL lapsed. */
async function backdateExpiry(db: Database, eventId: string) {
  await db.execute(
    sql`UPDATE processed_events SET expires_at = now() - interval '1 second' WHERE event_id = ${eventId}`,
  );
}

describe("Event deduplication", () => {
  const getApp = useTestApp();

  it("claims an event the first time as pending with a TTL expiry", async () => {
    const app = getApp();
    const before = Date.now();
    const claimed = await eventDedup.claimEvent(app.db, "evt_unique_1", "github");
    expect(claimed).toBe(true);

    const rows = await app.db.select().from(processedEvents).where(eq(processedEvents.eventId, "evt_unique_1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.expiresAt).not.toBeNull();
    const expiresMs = rows[0]?.expiresAt?.getTime() ?? 0;
    expect(expiresMs).toBeGreaterThanOrEqual(before + CLAIM_TTL_MS - 5000);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + CLAIM_TTL_MS + 5000);
  });

  it("rejects a duplicate event while the claim is pending and unexpired", async () => {
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

  it("markEventDone flips a pending claim to done and clears its expiry", async () => {
    const app = getApp();
    await eventDedup.claimEvent(app.db, "evt_done_1", "github");
    await eventDedup.markEventDone(app.db, "evt_done_1", "github");

    const rows = await app.db.select().from(processedEvents).where(eq(processedEvents.eventId, "evt_done_1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("done");
    expect(rows[0]?.expiresAt).toBeNull();
  });

  it("dedupes against a done claim forever", async () => {
    const app = getApp();
    await eventDedup.claimEvent(app.db, "evt_done_2", "github");
    await eventDedup.markEventDone(app.db, "evt_done_2", "github");
    const duplicate = await eventDedup.claimEvent(app.db, "evt_done_2", "github");
    expect(duplicate).toBe(false);
  });

  it("takes over an expired pending claim atomically (crash recovery)", async () => {
    const app = getApp();
    // Simulate a process crash: the claim landed but the handler never
    // completed (no markEventDone, no unclaimEvent).
    await eventDedup.claimEvent(app.db, "evt_crash_1", "github");
    await backdateExpiry(app.db, "evt_crash_1");

    const reclaimed = await eventDedup.claimEvent(app.db, "evt_crash_1", "github");
    expect(reclaimed).toBe(true);

    // The takeover refreshed the row back to a live pending claim.
    const rows = await app.db.select().from(processedEvents).where(eq(processedEvents.eventId, "evt_crash_1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect((rows[0]?.expiresAt?.getTime() ?? 0) > Date.now()).toBe(true);
  });

  it("sweepExpiredClaims deletes only expired pending claims", async () => {
    const app = getApp();
    // expired pending (crashed handler)
    await eventDedup.claimEvent(app.db, "evt_sweep_expired", "github");
    await backdateExpiry(app.db, "evt_sweep_expired");
    // live pending (in-flight handler)
    await eventDedup.claimEvent(app.db, "evt_sweep_live", "github");
    // done (completed)
    await eventDedup.claimEvent(app.db, "evt_sweep_done", "github");
    await eventDedup.markEventDone(app.db, "evt_sweep_done", "github");

    const swept = await eventDedup.sweepExpiredClaims(app.db);
    expect(swept).toBe(1);

    const remaining = await app.db
      .select({ eventId: processedEvents.eventId })
      .from(processedEvents)
      .where(and(eq(processedEvents.platform, "github")));
    const remainingIds = remaining.map((r) => r.eventId).sort();
    expect(remainingIds).toEqual(["evt_sweep_done", "evt_sweep_live"]);
  });
});
