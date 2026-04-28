/**
 * Phase 3c contract tests for the service-lock + per-notification-claim
 * helpers in `daemon/claim.ts`. Port of the Rust `lock.rs` + the broker's
 * in-memory `queued_threads` HashSet.
 *
 * Coverage:
 *   - `acquireServiceLock`: fresh acquire, double-acquire refusal, stale
 *     reclaim via heartbeat age, release.
 *   - `tryClaim` / `releaseClaim`: first writer wins, contention, stale
 *     reassignment at the claim TTL.
 *   - `cleanupExpiredClaims`: sweeps stale dirs.
 *   - `peekClaim`: read-only inspection.
 */

import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLAIM_STALE_AFTER_SEC,
  LOCK_STALE_AFTER_SEC,
  acquireServiceLock,
  cleanupExpiredClaims,
  findServiceLock,
  isLockStale,
  peekClaim,
  releaseClaim,
  tryClaim,
} from "../../src/daemon/claim.js";
import type { DaemonIdentity } from "../../src/daemon/identity.js";

function mkScratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `breeze-claim-${prefix}-`));
}

const IDENTITY: DaemonIdentity = {
  host: "github.com",
  login: "tester",
  gitProtocol: "https",
  scopes: ["repo", "notifications"],
};

describe("acquireServiceLock", () => {
  let root: string;
  beforeEach(() => {
    root = mkScratch("svc");
  });
  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates the lock dir and writes lock.env with the current identity", async () => {
    const handle = await acquireServiceLock({
      baseDir: root,
      identity: IDENTITY,
      profile: "default",
      note: "hello",
    });

    const info = handle.info();
    expect(info.pid).toBe(process.pid);
    expect(info.host).toBe("github.com");
    expect(info.login).toBe("tester");
    expect(info.profile).toBe("default");
    expect(info.note).toBe("hello");
    expect(info.heartbeat_epoch).toBeGreaterThan(0);

    // Confirm file-backed state round-trips via findServiceLock.
    const found = findServiceLock(root, IDENTITY, "default");
    expect(found?.pid).toBe(process.pid);

    await handle.release();
    expect(findServiceLock(root, IDENTITY, "default")).toBeNull();
  });

  it("refuses to acquire when a live lock is held by another pid", async () => {
    const first = await acquireServiceLock({
      baseDir: root,
      identity: IDENTITY,
      profile: "default",
    });

    await expect(
      acquireServiceLock({
        baseDir: root,
        identity: IDENTITY,
        profile: "default",
      }),
    ).rejects.toThrow(/already running/i);

    await first.release();
  });

  it("reclaims a stale lock when heartbeat is past the window", async () => {
    // Seed a stale lock file by hand.
    const stale: string = join(
      root,
      "github.com__tester__default".replace(/[^A-Za-z0-9_.-]/g, "_"),
    );
    // mkdir + lock.env with ancient heartbeat.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(stale, { recursive: true });
    const ancient = Math.floor(Date.now() / 1000) - (LOCK_STALE_AFTER_SEC + 60);
    writeFileSync(
      join(stale, "lock.env"),
      [
        "pid=999999",
        "host=github.com",
        "login=tester",
        "profile=default",
        `heartbeat_epoch=${ancient}`,
        `started_epoch=${ancient}`,
        "active_tasks=0",
        "note=stale",
      ].join("\n"),
      "utf-8",
    );

    const handle = await acquireServiceLock({
      baseDir: root,
      identity: IDENTITY,
      profile: "default",
    });
    expect(handle.info().pid).toBe(process.pid);
    await handle.release();
  });

  it("refresh updates heartbeat + note + active_tasks in place", async () => {
    const handle = await acquireServiceLock({
      baseDir: root,
      identity: IDENTITY,
      profile: "default",
    });
    const before = handle.info();
    // Wait a tiny bit so heartbeat_epoch can move forward (seconds precision).
    await new Promise((resolve) => setTimeout(resolve, 1100));
    handle.refresh(3, "working");
    const after = handle.info();
    expect(after.active_tasks).toBe(3);
    expect(after.note).toBe("working");
    expect(after.heartbeat_epoch).toBeGreaterThanOrEqual(before.heartbeat_epoch);

    await handle.release();
  });

  it("release is idempotent", async () => {
    const handle = await acquireServiceLock({
      baseDir: root,
      identity: IDENTITY,
      profile: "default",
    });
    await handle.release();
    await handle.release();
    expect(findServiceLock(root, IDENTITY, "default")).toBeNull();
  });
});

describe("isLockStale", () => {
  it("returns true when heartbeat is older than the window", () => {
    const now = 1_700_000_000;
    const info = {
      pid: process.pid,
      host: "github.com",
      login: "tester",
      profile: "default",
      heartbeat_epoch: now - (LOCK_STALE_AFTER_SEC + 1),
      started_epoch: now - (LOCK_STALE_AFTER_SEC + 1),
      active_tasks: 0,
      note: "",
    };
    expect(isLockStale(info, now)).toBe(true);
  });

  it("returns false when heartbeat is fresh and process is alive", () => {
    const now = Math.floor(Date.now() / 1000);
    const info = {
      pid: process.pid,
      host: "github.com",
      login: "tester",
      profile: "default",
      machine: require("node:os").hostname() as string,
      heartbeat_epoch: now,
      started_epoch: now,
      active_tasks: 0,
      note: "",
    };
    expect(isLockStale(info, now)).toBe(false);
  });

  it("returns true when the recorded pid is gone on this machine", () => {
    const now = Math.floor(Date.now() / 1000);
    const info = {
      pid: 999_999,
      host: "github.com",
      login: "tester",
      profile: "default",
      machine: require("node:os").hostname() as string,
      heartbeat_epoch: now,
      started_epoch: now,
      active_tasks: 0,
      note: "",
    };
    expect(isLockStale(info, now)).toBe(true);
  });

  it("treats legacy locks without a machine field as local for liveness checks", () => {
    const now = Math.floor(Date.now() / 1000);
    const info = {
      pid: 999_999,
      host: "github.com",
      login: "tester",
      profile: "default",
      heartbeat_epoch: now,
      started_epoch: now,
      active_tasks: 0,
      note: "",
    };
    expect(isLockStale(info, now)).toBe(true);
  });
});

describe("tryClaim / releaseClaim", () => {
  let claimsDir: string;
  beforeEach(() => {
    claimsDir = mkScratch("claim");
  });
  afterEach(() => {
    try {
      rmSync(claimsDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("first caller wins and writes claim metadata", () => {
    const result = tryClaim({
      claimsDir,
      id: "notif-1",
      sessionId: "session-a",
      action: "dispatch",
    });
    expect(result.claimed).toBe(true);
    const peek = peekClaim(claimsDir, "notif-1");
    expect(peek?.owner).toBe("session-a");
  });

  it("second concurrent caller is rejected with owner metadata", () => {
    const first = tryClaim({
      claimsDir,
      id: "notif-2",
      sessionId: "session-a",
    });
    expect(first.claimed).toBe(true);

    const second = tryClaim({
      claimsDir,
      id: "notif-2",
      sessionId: "session-b",
    });
    expect(second.claimed).toBe(false);
    expect(second.owner).toBe("session-a");
    expect(second.ageSec).toBeDefined();
  });

  it("reassigns the claim when older than CLAIM_STALE_AFTER_SEC", () => {
    // Fix "now" to simulate a stale first claim.
    const baseNow = new Date("2024-01-01T00:00:00Z");
    const first = tryClaim({
      claimsDir,
      id: "notif-3",
      sessionId: "session-a",
      now: () => baseNow,
    });
    expect(first.claimed).toBe(true);

    const later = new Date(baseNow.getTime() + (CLAIM_STALE_AFTER_SEC + 5) * 1000);
    const second = tryClaim({
      claimsDir,
      id: "notif-3",
      sessionId: "session-b",
      now: () => later,
    });
    expect(second.claimed).toBe(true);
    expect(second.ageSec).toBeGreaterThanOrEqual(CLAIM_STALE_AFTER_SEC);

    const peek = peekClaim(claimsDir, "notif-3");
    expect(peek?.owner).toBe("session-b");
  });

  it("releaseClaim removes the directory and is idempotent", () => {
    tryClaim({ claimsDir, id: "notif-4", sessionId: "s" });
    releaseClaim(claimsDir, "notif-4");
    releaseClaim(claimsDir, "notif-4"); // second call: no throw
    expect(existsSync(join(claimsDir, "notif-4"))).toBe(false);
  });

  it("cleanupExpiredClaims removes stale entries only", () => {
    const base = Date.now();
    // Fresh claim.
    tryClaim({
      claimsDir,
      id: "fresh",
      sessionId: "s",
      now: () => new Date(base),
    });
    // Stale claim via direct timestamp injection.
    tryClaim({
      claimsDir,
      id: "stale",
      sessionId: "s",
      now: () => new Date(base - (CLAIM_STALE_AFTER_SEC + 10) * 1000),
    });

    const removed = cleanupExpiredClaims(
      claimsDir,
      CLAIM_STALE_AFTER_SEC,
      base,
    );
    expect(removed).toBe(1);
    expect(existsSync(join(claimsDir, "fresh"))).toBe(true);
    expect(existsSync(join(claimsDir, "stale"))).toBe(false);
  });
});
