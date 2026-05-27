import { describe, expect, it } from "vitest";
import { PILL_VIEW } from "../computer-status-pill.js";

/**
 * The pill chip itself is a thin presentational wrapper around
 * `PILL_VIEW`. We pin the view-model contract (label + color token per
 * pill) so a label rewrite or palette swap is a deliberate change, not
 * a regression. Matches the convention used by `presence-chip.test.ts`.
 */
describe("PILL_VIEW — 4-state computer pill view model", () => {
  it("ready maps to 'Ready' + idle (green) color", () => {
    expect(PILL_VIEW.ready).toEqual({ label: "Ready", color: "var(--state-idle)" });
  });

  it("auth_expired maps to 'Auth expired' + error (red) color", () => {
    expect(PILL_VIEW.auth_expired).toEqual({ label: "Auth expired", color: "var(--state-error)" });
  });

  it("setup_incomplete maps to 'Setup incomplete' + blocked (amber) color", () => {
    expect(PILL_VIEW.setup_incomplete).toEqual({ label: "Setup incomplete", color: "var(--state-blocked)" });
  });

  it("offline maps to 'Offline' + muted (gray) color", () => {
    expect(PILL_VIEW.offline).toEqual({ label: "Offline", color: "var(--fg-3)" });
  });
});
