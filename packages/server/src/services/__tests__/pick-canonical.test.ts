import { describe, expect, it } from "vitest";
import { pickCanonical } from "../client.js";

/**
 * Pure-function tests for the soft-dedup canonical selection rule.
 *
 * `pickCanonical` is invoked by `registerClient` inside the dedup branch
 * after the advisory lock + candidate SELECT. The rule decides WHICH of
 * several rows for the same `(user_id, hostname, os)` tuple wins the
 * "canonical identity for this machine" title.
 *
 * Order (most preferred first):
 *   1. Non-archived rows beat archived rows.
 *   2. Higher `agentCount` beats lower.
 *   3. More-recent `lastSeenAt` beats older.
 *   4. Lexicographically smaller `id` beats larger (UUID v7 ≈ creation
 *      time ascending — oldest row wins the final tie-break).
 *
 * Each rule is tested in isolation, then a couple of stacked cases pin
 * the cascading order so a future refactor that flips two priorities is
 * caught.
 */

type Cand = {
  id: string;
  status: "connected" | "disconnected";
  lastSeenAt: Date;
  agentCount: number;
  archivedAt: Date | null;
};

function cand(overrides: Partial<Cand>): Cand {
  return {
    id: "client_default",
    status: "disconnected",
    lastSeenAt: new Date("2026-05-01T00:00:00Z"),
    agentCount: 0,
    archivedAt: null,
    ...overrides,
  };
}

describe("pickCanonical", () => {
  it("returns null for an empty candidate set", () => {
    expect(pickCanonical([])).toBeNull();
  });

  it("returns the single candidate when only one row matches", () => {
    const only = cand({ id: "client_only" });
    expect(pickCanonical([only])?.id).toBe("client_only");
  });

  it("prefers a non-archived row over an archived one — even if the archived row has more agents", () => {
    // Archival is the strongest negative signal: an archived row was abandoned
    // long enough ago that the sweep decided it was dead, so even if it
    // historically had work pinned to it, a live row should outrank it.
    const archived = cand({ id: "client_archived", agentCount: 5, archivedAt: new Date("2026-04-01T00:00:00Z") });
    const active = cand({ id: "client_active", agentCount: 0, archivedAt: null });
    expect(pickCanonical([archived, active])?.id).toBe("client_active");
  });

  it("when both rows are archived, falls through to the rest of the ordering rules", () => {
    // Archived-vs-archived: priority 1 is a wash; agentCount decides next.
    const a = cand({ id: "client_a", agentCount: 0, archivedAt: new Date("2026-04-01T00:00:00Z") });
    const b = cand({ id: "client_b", agentCount: 1, archivedAt: new Date("2026-04-01T00:00:00Z") });
    expect(pickCanonical([a, b])?.id).toBe("client_b");
  });

  it("prefers more agents pinned over fewer (within the same archival tier)", () => {
    const lonely = cand({ id: "client_lonely", agentCount: 0 });
    const busy = cand({ id: "client_busy", agentCount: 3 });
    expect(pickCanonical([lonely, busy])?.id).toBe("client_busy");
  });

  it("prefers more-recent lastSeenAt when agentCount ties", () => {
    const stale = cand({ id: "client_stale", lastSeenAt: new Date("2026-04-01T00:00:00Z") });
    const fresh = cand({ id: "client_fresh", lastSeenAt: new Date("2026-05-01T00:00:00Z") });
    expect(pickCanonical([stale, fresh])?.id).toBe("client_fresh");
  });

  it("breaks ties on lexicographically smallest id (UUID v7 ≈ creation order)", () => {
    const newer = cand({ id: "client_zzz" });
    const older = cand({ id: "client_aaa" });
    expect(pickCanonical([newer, older])?.id).toBe("client_aaa");
  });

  it("respects the full priority stack: non-archived > agentCount > lastSeen > id", () => {
    // Construct a 4-way race where each rule decides one pair.
    // - winner: non-archived, 1 agent, 2026-05-01, id 'client_b'
    // - peer A: non-archived, 1 agent, 2026-05-01, id 'client_c' (loses on id)
    // - peer B: non-archived, 1 agent, 2026-04-01, id 'client_a' (loses on lastSeen)
    // - peer C: non-archived, 0 agents, 2026-05-01, id 'client_a' (loses on agentCount)
    // - peer D: archived, 5 agents, 2026-05-01, id 'client_a' (loses on archival)
    const winner = cand({ id: "client_b", agentCount: 1, lastSeenAt: new Date("2026-05-01T00:00:00Z") });
    const peerA = cand({ id: "client_c", agentCount: 1, lastSeenAt: new Date("2026-05-01T00:00:00Z") });
    const peerB = cand({ id: "client_a", agentCount: 1, lastSeenAt: new Date("2026-04-01T00:00:00Z") });
    const peerC = cand({ id: "client_a", agentCount: 0, lastSeenAt: new Date("2026-05-01T00:00:00Z") });
    const peerD = cand({
      id: "client_a",
      agentCount: 5,
      lastSeenAt: new Date("2026-05-01T00:00:00Z"),
      archivedAt: new Date("2026-04-01T00:00:00Z"),
    });
    expect(pickCanonical([peerA, peerB, peerC, peerD, winner])?.id).toBe("client_b");
  });

  it("does not mutate the input array", () => {
    const a = cand({ id: "client_a", agentCount: 5 });
    const b = cand({ id: "client_b", agentCount: 1 });
    const input = [b, a];
    pickCanonical(input);
    expect(input.map((c) => c.id)).toEqual(["client_b", "client_a"]);
  });
});
