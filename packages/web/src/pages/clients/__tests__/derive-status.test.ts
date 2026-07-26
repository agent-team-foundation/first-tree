import { describe, expect, it } from "vitest";
import type { HubClient } from "../../../api/activity.js";
import {
  compareByPillPriority,
  deriveComputerStatus,
  hasUpdateProblem,
  PILL_PRIORITY,
  partitionTeamComputers,
  teamNeedsAttention,
} from "../derive-status.js";

/**
 * Pure-function unit tests for the 4-state Settings → Computers status
 * pill. The pill is computed entirely from existing server fields
 * (`status`, `authState`, `capabilities`) — no new server columns, no
 * thresholds. Ordering of the if/else ladder matters: see the comments
 * on `deriveComputerStatus` itself.
 */

const T = new Date("2026-05-01T00:00:00Z").toISOString();

function client(overrides: Partial<HubClient>): HubClient {
  return {
    id: "c-1",
    userId: "u-1",
    status: "connected",
    authState: "ok",
    binName: "first-tree-dev",
    sdkVersion: "v1.3.2",
    hostname: "MacBook-Pro.local",
    os: "macOS",
    agentCount: 0,
    connectedAt: T,
    lastSeenAt: T,
    capabilities: {},
    ...overrides,
  };
}

function capability(state: "ok" | "missing" | "error") {
  return {
    state,
    available: state === "ok",
    sdkVersion: state === "ok" ? "0.8.1" : null,
    detectedAt: T,
  };
}

describe("deriveComputerStatus", () => {
  it("returns Ready when connected, auth ok, and at least one capability is ok", () => {
    const c = client({ capabilities: { "claude-code": capability("ok") } });
    expect(deriveComputerStatus(c).pill).toBe("ready");
    expect(deriveComputerStatus(c).headline).toBe("Your computer is ready");
  });

  it("returns Ready when at least one capability is ok and others are missing", () => {
    const c = client({
      capabilities: { "claude-code": capability("ok"), codex: capability("missing") },
    });
    expect(deriveComputerStatus(c).pill).toBe("ready");
  });

  it("auth_expired wins over offline (server contract: expired ⊂ disconnected)", () => {
    const c = client({ status: "disconnected", authState: "expired" });
    expect(deriveComputerStatus(c).pill).toBe("auth_expired");
    expect(deriveComputerStatus(c).headline).toBe("Your computer needs to log in again");
  });

  it("auth_expired wins even when capabilities are ok (last-reported snapshot)", () => {
    // Server snapshots capability state during 'connected'; after going offline
    // long enough for the refresh token to lapse, the row carries
    // authState=expired but the capability snapshot is still 'ok'. The pill
    // must surface the credential death, not the stale runtime detail.
    const c = client({
      status: "disconnected",
      authState: "expired",
      capabilities: { "claude-code": capability("ok") },
    });
    expect(deriveComputerStatus(c).pill).toBe("auth_expired");
  });

  it("returns Offline when disconnected with auth still ok", () => {
    const c = client({ status: "disconnected", authState: "ok" });
    expect(deriveComputerStatus(c).pill).toBe("offline");
    expect(deriveComputerStatus(c).headline).toBe("Your computer is offline");
  });

  it("returns Setup incomplete when connected + auth ok but no capability is ok", () => {
    const c = client({
      capabilities: { "claude-code": capability("missing"), codex: capability("missing") },
    });
    expect(deriveComputerStatus(c).pill).toBe("setup_incomplete");
    expect(deriveComputerStatus(c).headline).toBe("Finish setting up your computer");
  });

  it("treats an empty capabilities map as Setup incomplete (no runtime probed)", () => {
    const c = client({ capabilities: {} });
    expect(deriveComputerStatus(c).pill).toBe("setup_incomplete");
  });

  it("treats error capabilities as not-ok (still Setup incomplete)", () => {
    const c = client({
      capabilities: { "claude-code": capability("error"), codex: capability("error") },
    });
    expect(deriveComputerStatus(c).pill).toBe("setup_incomplete");
  });

  it("is tolerant of a malformed capability entry (defensive optional chain)", () => {
    // A wire-shape drift / malformed jsonb could yield an entry missing `state`.
    // The pill derivation must not throw; treat the entry as not-ok.
    const c = client({
      // biome-ignore lint/suspicious/noExplicitAny: simulating a malformed payload
      capabilities: { "claude-code": {} as any },
    });
    expect(deriveComputerStatus(c).pill).toBe("setup_incomplete");
  });
});

describe("PILL_PRIORITY", () => {
  it("orders pills auth_expired < setup_incomplete < offline < ready (problems first)", () => {
    expect(PILL_PRIORITY.auth_expired).toBeLessThan(PILL_PRIORITY.setup_incomplete);
    expect(PILL_PRIORITY.setup_incomplete).toBeLessThan(PILL_PRIORITY.offline);
    expect(PILL_PRIORITY.offline).toBeLessThan(PILL_PRIORITY.ready);
  });
});

describe("compareByPillPriority", () => {
  it("sorts auth_expired ahead of ready", () => {
    const expired = client({ id: "exp", status: "disconnected", authState: "expired" });
    const ready = client({ id: "rdy", capabilities: { "claude-code": capability("ok") } });
    const sorted = [ready, expired].sort(compareByPillPriority);
    expect(sorted[0]?.id).toBe("exp");
    expect(sorted[1]?.id).toBe("rdy");
  });

  it("ties on pill priority break by hostname natural sort, not lastSeenAt", () => {
    const newer = client({ id: "newer", hostname: "box-10", lastSeenAt: "2026-05-01T10:00:00Z" });
    const older = client({ id: "older", hostname: "box-2", lastSeenAt: "2026-05-01T05:00:00Z" });
    // Both are setup_incomplete (no caps); stable identity order wins over recency.
    const sorted = [newer, older].sort(compareByPillPriority);
    expect(sorted[0]?.id).toBe("older");
    expect(sorted[1]?.id).toBe("newer");
  });

  it("puts unnamed computers after named computers within the same pill", () => {
    const unnamed = client({ id: "unnamed", hostname: null });
    const named = client({ id: "named", hostname: "alpha" });
    const sorted = [unnamed, named].sort(compareByPillPriority);
    expect(sorted[0]?.id).toBe("named");
    expect(sorted[1]?.id).toBe("unnamed");
  });

  it("falls back to client id when pill and hostname match", () => {
    const a = client({ id: "a" });
    const b = client({ id: "b" });
    const sorted = [b, a].sort(compareByPillPriority);
    expect(sorted[0]?.id).toBe("a");
    expect(sorted[1]?.id).toBe("b");
  });
});

function updateAttempt(result: "ok" | "failed" | "blocked", target = "1.4.0") {
  return { result, target, currentBefore: "1.3.2", installedVersion: null, reason: "npm E404", at: T };
}

describe("hasUpdateProblem", () => {
  it("is false when there is no update attempt", () => {
    expect(hasUpdateProblem(client({}))).toBe(false);
  });

  it("is false for a successful update", () => {
    expect(hasUpdateProblem(client({ lastUpdateAttempt: updateAttempt("ok") }))).toBe(false);
  });

  it("is true for a failed/blocked update still behind the target, within one channel", () => {
    // prod behind prod
    expect(hasUpdateProblem(client({ sdkVersion: "1.3.2", lastUpdateAttempt: updateAttempt("failed", "1.4.0") }))).toBe(
      true,
    );
    // same staging channel, older build
    expect(
      hasUpdateProblem(
        client({ sdkVersion: "0.5.3-staging.20.1", lastUpdateAttempt: updateAttempt("blocked", "0.5.3-staging.49.1") }),
      ),
    ).toBe(true);
  });

  it("is false once a valid same-channel version reached/passed the target (stale record)", () => {
    // Manual `first-tree upgrade` recovers without clearing the record: the
    // client re-registers on the target version but keeps the old failure.
    expect(
      hasUpdateProblem(client({ sdkVersion: "1.4.0", lastUpdateAttempt: updateAttempt("blocked", "1.4.0") })),
    ).toBe(false);
    expect(hasUpdateProblem(client({ sdkVersion: "1.5.0", lastUpdateAttempt: updateAttempt("failed", "1.4.0") }))).toBe(
      false,
    );
    // staging ahead by build number
    expect(
      hasUpdateProblem(
        client({ sdkVersion: "0.5.3-staging.60.1", lastUpdateAttempt: updateAttempt("blocked", "0.5.3-staging.49.1") }),
      ),
    ).toBe(false);
  });

  it("fails closed (stays true) for malformed, unknown-channel, or channel-mismatched versions", () => {
    const cases: Array<[string | null, string]> = [
      // digit-bearing garbage must not outrank a valid target
      ["garbage999", "1.4.0"],
      // partial version is not a valid release
      ["1.4", "1.4.0"],
      // unknown prerelease channels fail closed even if numerically "ahead"
      ["1.4.0-alpha.999.1", "1.4.0-staging.49.1"],
      ["1.4.0-beta.1", "1.4.0-staging.1.1"],
      ["1.4.0-rc.1", "1.4.0"],
      // channel mismatch: a staging prerelease has NOT reached a stable prod target
      ["1.4.0-staging.5.1", "1.4.0"],
      ["1.4.0", "1.4.0-staging.49.1"],
      // leading-zero numeric identifiers are invalid SemVer → fail closed
      ["01.4.0", "1.4.0"],
      ["1.4.0-staging.049.1", "1.4.0-staging.49.1"],
      // missing / non-numeric current
      [null, "1.4.0"],
      ["dev", "1.4.0"],
      // malformed target also fails closed
      ["1.5.0", "not-a-version"],
    ];
    for (const [sdkVersion, target] of cases) {
      expect(hasUpdateProblem(client({ sdkVersion, lastUpdateAttempt: updateAttempt("blocked", target) }))).toBe(true);
    }
  });

  it("compares numeric identifiers exactly past 2^53 (no IEEE-754 collapse)", () => {
    // These differ by 1 but round to the same JS double; string compare keeps them apart.
    const lower = "9007199254740992.0.0";
    const higher = "9007199254740993.0.0";
    // current one build behind target → still unresolved
    expect(hasUpdateProblem(client({ sdkVersion: lower, lastUpdateAttempt: updateAttempt("blocked", higher) }))).toBe(
      true,
    );
    // current at/beyond target → resolved
    expect(hasUpdateProblem(client({ sdkVersion: higher, lastUpdateAttempt: updateAttempt("failed", lower) }))).toBe(
      false,
    );
  });
});

describe("teamNeedsAttention", () => {
  it("is false for a healthy Ready machine with no update problem", () => {
    const c = client({ capabilities: { "claude-code": capability("ok") } });
    expect(deriveComputerStatus(c).pill).toBe("ready");
    expect(teamNeedsAttention(c)).toBe(false);
  });

  it("is true for any non-ready pill", () => {
    expect(teamNeedsAttention(client({ status: "disconnected", authState: "ok" }))).toBe(true);
    expect(teamNeedsAttention(client({ status: "disconnected", authState: "expired" }))).toBe(true);
    expect(teamNeedsAttention(client({ capabilities: {} }))).toBe(true);
  });

  it("is true for a Ready machine whose self-update failed/blocked (never hidden under Ready)", () => {
    const stuck = client({
      capabilities: { "claude-code": capability("ok") },
      lastUpdateAttempt: updateAttempt("failed"),
    });
    expect(deriveComputerStatus(stuck).pill).toBe("ready");
    expect(teamNeedsAttention(stuck)).toBe(true);
  });
});

describe("partitionTeamComputers", () => {
  it("splits attention (non-ready OR update-stuck) from the ready fleet", () => {
    const offline = client({ id: "offline", hostname: "z-off", status: "disconnected", authState: "ok" });
    const readyClean = client({ id: "ready", hostname: "a-ready", capabilities: { "claude-code": capability("ok") } });
    const updateStuck = client({
      id: "stuck",
      hostname: "m-stuck",
      capabilities: { "claude-code": capability("ok") },
      lastUpdateAttempt: updateAttempt("failed"),
    });
    const { attention, ready } = partitionTeamComputers([readyClean, updateStuck, offline]);
    // offline (pill priority 2) sorts ahead of the update-stuck Ready machine (pill 3).
    expect(attention.map((c) => c.id)).toEqual(["offline", "stuck"]);
    expect(ready.map((c) => c.id)).toEqual(["ready"]);
  });

  it("orders the attention group by pill priority, with update-stuck Ready machines last", () => {
    const authExpired = client({ id: "auth", status: "disconnected", authState: "expired" });
    const offline = client({ id: "offline", status: "disconnected", authState: "ok" });
    const updateStuck = client({
      id: "stuck",
      capabilities: { "claude-code": capability("ok") },
      lastUpdateAttempt: updateAttempt("blocked"),
    });
    const { attention } = partitionTeamComputers([updateStuck, offline, authExpired]);
    expect(attention.map((c) => c.id)).toEqual(["auth", "offline", "stuck"]);
  });

  it("returns an empty attention group for an all-healthy fleet", () => {
    const a = client({ id: "a", hostname: "a", capabilities: { "claude-code": capability("ok") } });
    const b = client({ id: "b", hostname: "b", capabilities: { "claude-code": capability("ok") } });
    const { attention, ready } = partitionTeamComputers([a, b]);
    expect(attention).toEqual([]);
    expect(ready.map((c) => c.id)).toEqual(["a", "b"]);
  });
});
