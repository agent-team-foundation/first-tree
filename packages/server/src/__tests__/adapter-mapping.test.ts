import { describe, expect, it } from "vitest";
import * as mappingService from "../services/adapter-mapping.js";
import { useTestApp } from "./helpers.js";

describe("Adapter event deduplication", () => {
  const getApp = useTestApp();

  it("claims an event the first time", async () => {
    const app = getApp();
    const claimed = await mappingService.claimEvent(app.db, "evt_unique_1", "github");
    expect(claimed).toBe(true);
  });

  it("rejects a duplicate event", async () => {
    const app = getApp();
    await mappingService.claimEvent(app.db, "evt_dup_1", "github");
    const duplicate = await mappingService.claimEvent(app.db, "evt_dup_1", "github");
    expect(duplicate).toBe(false);
  });

  it("allows same event_id on different platforms", async () => {
    const app = getApp();
    const r1 = await mappingService.claimEvent(app.db, "evt_cross_1", "github");
    const r2 = await mappingService.claimEvent(app.db, "evt_cross_1", "other");
    expect(r1).toBe(true);
    expect(r2).toBe(true);
  });

  it("unclaimEvent allows a re-claim", async () => {
    const app = getApp();
    await mappingService.claimEvent(app.db, "evt_unclaim_1", "github");
    await mappingService.unclaimEvent(app.db, "evt_unclaim_1", "github");
    const reclaimed = await mappingService.claimEvent(app.db, "evt_unclaim_1", "github");
    expect(reclaimed).toBe(true);
  });
});
