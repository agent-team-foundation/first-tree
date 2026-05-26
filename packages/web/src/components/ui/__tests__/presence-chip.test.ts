import { describe, expect, it } from "vitest";
import { presenceChipView } from "../presence-chip.js";

describe("presenceChipView — two-state reachability view", () => {
  it("online resolves to the idle accent color and 'Online' label", () => {
    const v = presenceChipView("online");
    expect(v.status).toBe("online");
    expect(v.label).toBe("Online");
    expect(v.color).toBe("var(--state-idle)");
  });

  it("offline resolves to the muted foreground color and 'Offline' label", () => {
    const v = presenceChipView("offline");
    expect(v.status).toBe("offline");
    expect(v.label).toBe("Offline");
    expect(v.color).toBe("var(--fg-3)");
  });

  // Defensive: the wire type is `PresenceStatus | undefined` (server adds
  // `?? "offline"` already, but the DTO is optional). The chip must collapse
  // null / undefined to "offline" so no upstream omission renders blank.
  it("null collapses to offline", () => {
    expect(presenceChipView(null)).toEqual(presenceChipView("offline"));
  });

  it("undefined collapses to offline", () => {
    expect(presenceChipView(undefined)).toEqual(presenceChipView("offline"));
  });
});
