import { describe, expect, it } from "vitest";
import { processedEvents } from "../db/schema/processed-events.js";

describe("database schema exports", () => {
  it("exports the processed events table metadata", () => {
    expect(processedEvents).toBeDefined();
    expect(processedEvents.eventId.name).toBe("event_id");
    expect(processedEvents.platform.notNull).toBe(true);
  });
});
