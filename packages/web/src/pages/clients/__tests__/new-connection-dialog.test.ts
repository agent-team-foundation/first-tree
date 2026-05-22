import { describe, expect, it } from "vitest";
import type { HubClient } from "../../../api/activity.js";
import { selectArrivedClient } from "../new-connection-dialog.js";

/**
 * Pure-function unit tests for the "+ New Connection" wait-loop detector.
 * The hook itself drives this from a setInterval; the visual surface is
 * covered by manual e2e on /clients → "+ New Connection". Regression net
 * exists because the previous id-set baseline silently missed the
 * reconnect case (machines whose `client.id` is stable per-machine — see
 * `packages/shared/src/config/client-config.ts`).
 */

const ME = "user-me";
const OTHER = "user-other";
const T0 = 1_700_000_000_000;
const OPENED_AT = T0;

function client(overrides: Partial<HubClient>): HubClient {
  return {
    id: overrides.id ?? "client-1",
    userId: ME,
    status: "connected",
    authState: "ok",
    sdkVersion: "v1.0.0",
    hostname: "host",
    os: "macOS",
    agentCount: 0,
    connectedAt: new Date(T0).toISOString(),
    lastSeenAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

describe("selectArrivedClient", () => {
  it("returns null for an empty list", () => {
    expect(selectArrivedClient([], OPENED_AT, ME)).toBeNull();
  });

  it("returns null when userId is the empty string (auth not warm)", () => {
    expect(selectArrivedClient([client({})], OPENED_AT, "")).toBeNull();
  });

  it("catches a brand-new machine whose handshake landed after the modal opened", () => {
    const arrived = client({ id: "fresh", connectedAt: new Date(OPENED_AT + 5_000).toISOString() });
    expect(selectArrivedClient([arrived], OPENED_AT, ME)).toBe(arrived);
  });

  it("catches a reconnect — same client.id, connectedAt rewritten to NOW by server ON CONFLICT", () => {
    // Modal opens; an old client row is sitting there as disconnected with a
    // historical connectedAt. User runs the connect command on that same
    // machine; server flips status=connected and updates connectedAt to NOW.
    // The fix is that we trust connectedAt, not "is the id new?".
    const reconnected = client({
      id: "stable-machine",
      connectedAt: new Date(OPENED_AT + 4_000).toISOString(),
    });
    expect(selectArrivedClient([reconnected], OPENED_AT, ME)).toBe(reconnected);
  });

  it("ignores an already-connected machine with a historical connectedAt (no false success)", () => {
    const old = client({
      id: "long-running",
      connectedAt: new Date(OPENED_AT - 60_000).toISOString(),
    });
    expect(selectArrivedClient([old], OPENED_AT, ME)).toBeNull();
  });

  it("ignores rows whose status is disconnected even if connectedAt is recent", () => {
    // Defensive: server contract says status=disconnected → connectedAt
    // reflects the *previous* connection. We must not auto-success on a row
    // that's offline regardless of when it last connected.
    const offline = client({
      id: "flapping",
      status: "disconnected",
      connectedAt: new Date(OPENED_AT + 1_000).toISOString(),
    });
    expect(selectArrivedClient([offline], OPENED_AT, ME)).toBeNull();
  });

  it("ignores rows whose connectedAt is null (never connected since cold-start)", () => {
    const naked = client({ id: "never", connectedAt: null });
    expect(selectArrivedClient([naked], OPENED_AT, ME)).toBeNull();
  });

  it("ignores rows owned by another user (defence in depth — server already scopes /me/clients)", () => {
    const theirs = client({
      id: "theirs",
      userId: OTHER,
      connectedAt: new Date(OPENED_AT + 2_000).toISOString(),
    });
    expect(selectArrivedClient([theirs], OPENED_AT, ME)).toBeNull();
  });

  it("treats connectedAt EXACTLY equal to openedAt as 'after' (≥, not >)", () => {
    // The dialog already subtracts a 1s fudge from openedAt to absorb clock
    // skew, but the boundary itself should be inclusive — a handshake stamp
    // that happens to tie the threshold is still a valid arrival.
    const onTheDot = client({ id: "boundary", connectedAt: new Date(OPENED_AT).toISOString() });
    expect(selectArrivedClient([onTheDot], OPENED_AT, ME)).toBe(onTheDot);
  });

  it("returns the first matching client when several qualify", () => {
    const a = client({ id: "a", connectedAt: new Date(OPENED_AT + 1_000).toISOString() });
    const b = client({ id: "b", connectedAt: new Date(OPENED_AT + 2_000).toISOString() });
    expect(selectArrivedClient([a, b], OPENED_AT, ME)?.id).toBe("a");
  });
});
