import { describe, expect, it } from "vitest";
import * as eventDedup from "../services/event-dedup.js";
import { useTestApp } from "./helpers.js";

describe("Event deduplication", () => {
  const getApp = useTestApp();

  it("claims an event the first time", async () => {
    const app = getApp();
    const claimed = await eventDedup.claimEvent(app.db, "evt_unique_1", "github");
    expect(claimed).toBe(true);
  });

  it("rejects a duplicate event", async () => {
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
});
