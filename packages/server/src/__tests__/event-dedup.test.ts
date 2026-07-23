import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { processedEvents } from "../db/schema/processed-events.js";
import * as eventDedup from "../services/event-dedup.js";
import { useTestApp } from "./helpers.js";

const TTL_SECONDS = 300;

describe("Event deduplication (claim lease)", () => {
  const getApp = useTestApp();

  type App = ReturnType<typeof getApp>;

  async function getRow(app: App, eventId: string, platform = "github") {
    const [row] = await app.db
      .select()
      .from(processedEvents)
      .where(and(eq(processedEvents.eventId, eventId), eq(processedEvents.platform, platform)));
    return row;
  }

  /** Rewind a pending claim's expiry into the past — the test-time stand-in
   * for "the TTL elapsed" (or "the claiming process crashed long ago"). */
  async function expireClaim(app: App, eventId: string, platform = "github") {
    await app.db
      .update(processedEvents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(and(eq(processedEvents.eventId, eventId), eq(processedEvents.platform, platform)));
  }

  it("claims an event the first time and returns the owning token", async () => {
    const app = getApp();
    const token = await eventDedup.claimEvent(app.db, "evt_first_1", "github", TTL_SECONDS);
    expect(token).toEqual(expect.any(String));

    const row = await getRow(app, "evt_first_1");
    expect(row).toMatchObject({ status: "pending", claimToken: token });
    expect(row?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns null for a duplicate while the pending claim is unexpired", async () => {
    const app = getApp();
    await eventDedup.claimEvent(app.db, "evt_dup_1", "github", TTL_SECONDS);
    const duplicate = await eventDedup.claimEvent(app.db, "evt_dup_1", "github", TTL_SECONDS);
    expect(duplicate).toBeNull();
  });

  it("returns null forever once the event is done", async () => {
    const app = getApp();
    const token = await eventDedup.claimEvent(app.db, "evt_done_1", "github", TTL_SECONDS);
    if (token === null) throw new Error("expected initial claim to win");
    expect(await eventDedup.completeEvent(app.db, "evt_done_1", "github", token)).toBe(true);
    expect(await eventDedup.claimEvent(app.db, "evt_done_1", "github", TTL_SECONDS)).toBeNull();
  });

  it("treats rows predating the lease columns as done (legacy dedupe markers)", async () => {
    const app = getApp();
    // Simulate a row written by pre-lease code: only (event_id, platform),
    // every lease column filled by its column default.
    await app.db.execute(sql`INSERT INTO processed_events (event_id, platform) VALUES ('evt_legacy_1', 'github')`);

    expect(await eventDedup.claimEvent(app.db, "evt_legacy_1", "github", TTL_SECONDS)).toBeNull();
    const row = await getRow(app, "evt_legacy_1");
    expect(row).toMatchObject({ status: "done", expiresAt: null, claimToken: null });
  });

  it("takes over an expired pending claim with a fresh token", async () => {
    const app = getApp();
    const firstToken = await eventDedup.claimEvent(app.db, "evt_takeover_1", "github", TTL_SECONDS);
    if (firstToken === null) throw new Error("expected initial claim to win");
    await expireClaim(app, "evt_takeover_1");

    const secondToken = await eventDedup.claimEvent(app.db, "evt_takeover_1", "github", TTL_SECONDS);
    expect(secondToken).toEqual(expect.any(String));
    expect(secondToken).not.toBe(firstToken);

    const row = await getRow(app, "evt_takeover_1");
    expect(row).toMatchObject({ status: "pending", claimToken: secondToken });
    expect(row?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("allows same event_id on different platforms", async () => {
    const app = getApp();
    const r1 = await eventDedup.claimEvent(app.db, "evt_cross_1", "github", TTL_SECONDS);
    const r2 = await eventDedup.claimEvent(app.db, "evt_cross_1", "other", TTL_SECONDS);
    expect(r1).toEqual(expect.any(String));
    expect(r2).toEqual(expect.any(String));
  });

  it("completeEvent with the owning token marks the row done and clears the lease", async () => {
    const app = getApp();
    const token = await eventDedup.claimEvent(app.db, "evt_complete_1", "github", TTL_SECONDS);
    if (token === null) throw new Error("expected initial claim to win");

    expect(await eventDedup.completeEvent(app.db, "evt_complete_1", "github", token)).toBe(true);
    const row = await getRow(app, "evt_complete_1");
    expect(row).toMatchObject({ status: "done", expiresAt: null, claimToken: null });
  });

  it("completeEvent with a stale token returns false and leaves the row alone", async () => {
    const app = getApp();
    const firstToken = await eventDedup.claimEvent(app.db, "evt_stale_complete_1", "github", TTL_SECONDS);
    if (firstToken === null) throw new Error("expected initial claim to win");
    await expireClaim(app, "evt_stale_complete_1");
    const takeoverToken = await eventDedup.claimEvent(app.db, "evt_stale_complete_1", "github", TTL_SECONDS);
    if (takeoverToken === null) throw new Error("expected takeover claim to win");

    // The original (slow, superseded) attempt tries to complete late.
    expect(await eventDedup.completeEvent(app.db, "evt_stale_complete_1", "github", firstToken)).toBe(false);
    const row = await getRow(app, "evt_stale_complete_1");
    expect(row).toMatchObject({ status: "pending", claimToken: takeoverToken });
  });

  it("releaseClaimedEvent makes the claim immediately reclaimable", async () => {
    const app = getApp();
    const token = await eventDedup.claimEvent(app.db, "evt_release_1", "github", TTL_SECONDS);
    if (token === null) throw new Error("expected initial claim to win");

    await eventDedup.releaseClaimedEvent(app.db, "evt_release_1", "github", token);
    const row = await getRow(app, "evt_release_1");
    expect(row?.status).toBe("pending");

    const reclaimed = await eventDedup.claimEvent(app.db, "evt_release_1", "github", TTL_SECONDS);
    expect(reclaimed).toEqual(expect.any(String));
    expect(reclaimed).not.toBe(token);
  });

  it("a late release with a stale token does not disturb the takeover's active claim", async () => {
    const app = getApp();
    const firstToken = await eventDedup.claimEvent(app.db, "evt_stale_release_1", "github", TTL_SECONDS);
    if (firstToken === null) throw new Error("expected initial claim to win");
    await expireClaim(app, "evt_stale_release_1");
    const takeoverToken = await eventDedup.claimEvent(app.db, "evt_stale_release_1", "github", TTL_SECONDS);
    if (takeoverToken === null) throw new Error("expected takeover claim to win");

    await eventDedup.releaseClaimedEvent(app.db, "evt_stale_release_1", "github", firstToken);

    const row = await getRow(app, "evt_stale_release_1");
    expect(row).toMatchObject({ status: "pending", claimToken: takeoverToken });
    expect(row?.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    // The takeover's claim still shields the delivery from another claim.
    expect(await eventDedup.claimEvent(app.db, "evt_stale_release_1", "github", TTL_SECONDS)).toBeNull();
  });

  it("exactly one of two concurrent claims wins an expired pending takeover", async () => {
    const app = getApp();
    const initial = await eventDedup.claimEvent(app.db, "evt_race_1", "github", TTL_SECONDS);
    if (initial === null) throw new Error("expected initial claim to win");
    await expireClaim(app, "evt_race_1");

    const [a, b] = await Promise.all([
      eventDedup.claimEvent(app.db, "evt_race_1", "github", TTL_SECONDS),
      eventDedup.claimEvent(app.db, "evt_race_1", "github", TTL_SECONDS),
    ]);

    const winners = [a, b].filter((token) => token !== null);
    expect(winners).toHaveLength(1);
    const row = await getRow(app, "evt_race_1");
    expect(row).toMatchObject({ status: "pending", claimToken: winners[0] });
  });

  it("readClaimState reports pending with expiry, done without, and null for missing rows", async () => {
    const app = getApp();
    const token = await eventDedup.claimEvent(app.db, "evt_read_1", "github", TTL_SECONDS);
    if (token === null) throw new Error("expected initial claim to win");

    const pending = await eventDedup.readClaimState(app.db, "evt_read_1", "github");
    expect(pending?.state).toBe("pending");
    expect(pending?.expiresAt?.getTime()).toBeGreaterThan(Date.now());

    await eventDedup.completeEvent(app.db, "evt_read_1", "github", token);
    expect(await eventDedup.readClaimState(app.db, "evt_read_1", "github")).toEqual({
      state: "done",
      expiresAt: null,
    });

    expect(await eventDedup.readClaimState(app.db, "evt_read_missing", "github")).toBeNull();
  });
});
