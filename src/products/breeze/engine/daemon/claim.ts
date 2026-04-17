/**
 * Phase 3c: service-wide lock + per-notification claim helpers for the
 * TypeScript breeze daemon.
 *
 * Port of `lock.rs`.
 *
 * SINGLE-WRITER RULE (spec doc 2 §1.3):
 * -------------------------------------
 * This module is **read-only** with respect to `~/.breeze/inbox.json`.
 * Everything it writes lives under the daemon-private lock/claim dirs:
 *   - `<lockDir>/` — one subdirectory per (host, login, profile) tuple,
 *     holding `lock.env` with pid/heartbeat/note. Mirrors Rust
 *     `ServiceLock` (`lock.rs:59-137`).
 *   - `<claimsDir>/<notification-id>/` — per-thread claim directory used
 *     by the broker to exclude duplicate dispatches for the same
 *     thread_key in rapid succession. Mirrors the Rust-side
 *     `queued_threads` HashSet but persists across restarts.
 *
 * We use `proper-lockfile` as the low-level primitive for the service
 * lock. Rust's `lock.rs` relied on atomic `create_dir` + a heartbeat
 * file; `proper-lockfile` gives us the same "directory-exists = owned"
 * semantics with automatic stale-lock detection. Differences with Rust
 * captured inline.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { lock as pflock, unlock as pfunlock } from "proper-lockfile";

import type { DaemonIdentity } from "./identity.js";
import { identityLockKey } from "./identity.js";

/**
 * Heartbeat-staleness window (in seconds). Matches Rust `is_lock_stale`
 * in `lock.rs:174-176` (20 minutes). If the current epoch is more than
 * this many seconds beyond the recorded heartbeat, we consider the
 * previous holder gone and reclaim the dir.
 */
export const LOCK_STALE_AFTER_SEC = 20 * 60;

/**
 * Per-notification claim staleness. Mirrors `CLAIM_TIMEOUT_SECS` in
 * `runtime/config.ts` (5 minutes) so the daemon and the skill agree on
 * when a claim can be reassigned.
 */
export const CLAIM_STALE_AFTER_SEC = 5 * 60;

export interface LockInfo {
  pid: number;
  host: string;
  login: string;
  profile: string;
  heartbeat_epoch: number;
  started_epoch: number;
  active_tasks: number;
  note: string;
}

export interface ServiceLockHandle {
  /** Absolute path to the lock directory (contains `lock.env`). */
  dir: string;
  /** Read the current lock metadata. */
  info(): LockInfo;
  /** Update heartbeat + active-task count + note. Rewrites `lock.env`. */
  refresh(activeTasks: number, note: string): void;
  /** Release the lock (removes the directory). Idempotent. */
  release(): Promise<void>;
}

function currentEpochSec(): number {
  return Math.floor(Date.now() / 1000);
}

function sanitizeFilename(value: string): string {
  // Matches Rust `util::sanitize_filename` closely: replace anything
  // that isn't alphanumeric / `-` / `_` / `.` with `_`.
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function encodeMultiline(text: string): string {
  // Rust's encode_multiline replaces `\\` with `\\\\` and `\n` with `\\n`
  // so the kv file can round-trip arbitrary text.
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function decodeMultiline(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "n") {
        out += "\n";
        i += 1;
        continue;
      }
      if (next === "\\") {
        out += "\\";
        i += 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function serialiseLockInfo(info: LockInfo): string {
  return [
    `pid=${info.pid}`,
    `host=${info.host}`,
    `login=${info.login}`,
    `profile=${info.profile}`,
    `heartbeat_epoch=${info.heartbeat_epoch}`,
    `started_epoch=${info.started_epoch}`,
    `active_tasks=${info.active_tasks}`,
    `note=${encodeMultiline(info.note)}`,
  ].join("\n");
}

function parseLockInfo(contents: string): LockInfo | null {
  const entries: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    entries[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const pid = Number.parseInt(entries.pid ?? "", 10);
  if (!Number.isFinite(pid)) return null;
  const heartbeat = Number.parseInt(entries.heartbeat_epoch ?? "", 10);
  if (!Number.isFinite(heartbeat)) return null;
  const started = Number.parseInt(entries.started_epoch ?? "", 10);
  const activeTasks = Number.parseInt(entries.active_tasks ?? "0", 10);
  return {
    pid,
    host: entries.host ?? "",
    login: entries.login ?? "",
    profile: entries.profile ?? "",
    heartbeat_epoch: heartbeat,
    started_epoch: Number.isFinite(started) ? started : heartbeat,
    active_tasks: Number.isFinite(activeTasks) ? activeTasks : 0,
    note: decodeMultiline(entries.note ?? ""),
  };
}

/** True if the recorded pid is still alive on this host. */
function processAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // `process.kill(pid, 0)` throws if the process is gone or we lack
    // permission. We treat both as "not us" — the heartbeat staleness
    // check picks up the permission case.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stale-detection predicate. Rust uses `heartbeat older than 20 min OR
 * process not alive`. We match that exactly.
 *
 * Exported for tests.
 */
export function isLockStale(info: LockInfo, now: number = currentEpochSec()): boolean {
  const expired = Math.max(0, now - info.heartbeat_epoch) > LOCK_STALE_AFTER_SEC;
  if (expired) return true;
  if (info.host === hostname()) {
    // Only trust the liveness probe when the recorded host matches
    // ours — otherwise `kill -0` would always report "not alive".
    return !processAlive(info.pid);
  }
  // Different host: we can't probe the pid, so trust the heartbeat.
  return false;
}

/**
 * Resolve the directory that owns the `(host, login, profile)` tuple's
 * lock. Exported for `findServiceLock` / `stopServiceLock` callers.
 */
export function serviceLockDir(
  baseDir: string,
  identity: DaemonIdentity,
  profile: string,
): string {
  return join(baseDir, sanitizeFilename(identityLockKey(identity, profile)));
}

function readLockInfoFromPath(path: string): LockInfo | null {
  if (!existsSync(path)) return null;
  try {
    return parseLockInfo(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Locate the current lock for this identity/profile, if any. Mirrors
 * Rust `find_lock` (`lock.rs:146-153`). Returns `null` when no lock.env
 * exists.
 */
export function findServiceLock(
  baseDir: string,
  identity: DaemonIdentity,
  profile: string,
): LockInfo | null {
  const dir = serviceLockDir(baseDir, identity, profile);
  return readLockInfoFromPath(join(dir, "lock.env"));
}

export interface AcquireServiceLockOptions {
  baseDir: string;
  identity: DaemonIdentity;
  profile: string;
  /** Note written alongside the initial heartbeat. Defaults to `started`. */
  note?: string;
}

/**
 * Acquire the per-identity service lock. Throws if another live daemon
 * owns it. Stale locks (heartbeat > 20min OR process gone) are reclaimed
 * automatically, mirroring Rust's retry loop (`lock.rs:72-103`).
 *
 * We use `proper-lockfile` to *additionally* guard the lock.env write
 * itself — that gives us cross-process protection against two TS daemons
 * racing `acquireServiceLock` on the same machine at the exact same
 * moment. The outer directory is the durable marker.
 */
export async function acquireServiceLock(
  options: AcquireServiceLockOptions,
): Promise<ServiceLockHandle> {
  const { baseDir, identity, profile } = options;
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  const dir = serviceLockDir(baseDir, identity, profile);
  const infoPath = join(dir, "lock.env");

  const maxTries = 3;
  for (let attempt = 1; attempt <= maxTries; attempt += 1) {
    try {
      mkdirSync(dir);
      // Fresh creation — proceed to write lock.env below.
      break;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") {
        throw new Error(
          `failed to create lock directory "${dir}": ${e.message}`,
        );
      }
      const existing = readLockInfoFromPath(infoPath);
      if (existing && !isLockStale(existing)) {
        throw new Error(
          `breeze daemon is already running for ${existing.login} on ${existing.host} (pid ${existing.pid}, profile "${existing.profile}")`,
        );
      }
      // Stale (or malformed): scrub and retry.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore — next loop iteration will surface any remaining error */
      }
      if (attempt === maxTries) {
        throw new Error(
          `failed to reclaim stale lock directory "${dir}" after ${maxTries} attempts`,
        );
      }
    }
  }

  const info: LockInfo = {
    pid: process.pid,
    host: identity.host,
    login: identity.login,
    profile,
    heartbeat_epoch: currentEpochSec(),
    started_epoch: currentEpochSec(),
    active_tasks: 0,
    note: options.note ?? "started",
  };
  writeFileSync(infoPath, `${serialiseLockInfo(info)}\n`, "utf-8");

  // Take a proper-lockfile lock on infoPath. This is not the durable
  // ownership record — that's the directory — but it gives us a well-
  // tested primitive for the refresh path (rename-on-update) and a
  // cross-process barrier for the acquire race described above.
  let pfReleased = false;
  const pfRelease = await pflock(infoPath, {
    stale: LOCK_STALE_AFTER_SEC * 1000,
    retries: { retries: 2, minTimeout: 50, maxTimeout: 200 },
  }).catch(() => {
    // If proper-lockfile can't take the .lock sentinel, fall back to
    // directory-only ownership. This matches Rust's behaviour (Rust
    // has no proper-lockfile equivalent) and keeps the TS port working
    // in tmpfs / network mount edge cases.
    return null;
  });

  let current = info;
  const handle: ServiceLockHandle = {
    dir,
    info: () => ({ ...current }),
    refresh: (activeTasks, note) => {
      current = {
        ...current,
        active_tasks: activeTasks,
        heartbeat_epoch: currentEpochSec(),
        note,
      };
      writeFileSync(infoPath, `${serialiseLockInfo(current)}\n`, "utf-8");
    },
    release: async () => {
      if (pfRelease && !pfReleased) {
        pfReleased = true;
        try {
          await pfRelease();
        } catch {
          /* ignore — best-effort release */
        }
        try {
          await pfunlock(infoPath).catch(() => undefined);
        } catch {
          /* ignore */
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
  return handle;
}

/* ------------------------------------------------------------------ */
/* Per-notification claims — used by the broker to exclude duplicate  */
/* dispatches of the same thread.                                     */
/* ------------------------------------------------------------------ */

/**
 * Per-thread claim semantics (matches `commands/status-manager.ts`
 * `cmdClaim` and the Rust-side `queued_threads` set):
 *
 *   - `claimsDir/<id>/` exists → the thread is claimed.
 *   - `claimsDir/<id>/claimed_at` holds an ISO-8601 timestamp.
 *   - A claim older than `CLAIM_STALE_AFTER_SEC` (5 min) can be
 *     reassigned by any caller. Matches the skill's UX.
 *
 * The broker uses this to avoid double-dispatching the same
 * `thread_key` in two passes of the poll loop. It is cheaper than the
 * Rust in-memory `HashSet<thread_key>` but survives restarts — which is
 * the main value-add for the TS port, since Node can be killed at any
 * time.
 */

export interface ClaimResult {
  claimed: boolean;
  /** Session id of the current owner if `claimed=false`. */
  owner?: string;
  /** Age of the existing claim in seconds (if any). */
  ageSec?: number;
}

export interface ClaimOptions {
  claimsDir: string;
  /** Notification id (== thread_key in broker parlance). */
  id: string;
  /** Session id — who is claiming. */
  sessionId: string;
  /** Freeform action label (e.g. `dispatch`, `working`). */
  action?: string;
  /** Override for tests. */
  now?: () => Date;
  /** Override staleness window (seconds). Defaults to 5 min. */
  claimStaleSec?: number;
}

function formatUtcIso(date: Date): string {
  // Seconds precision, matching `formatUtcIso` in `commands/poll.ts`.
  return `${date.toISOString().slice(0, 19)}Z`;
}

function parseIsoUtc(value: string | undefined | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function writeClaimBody(claimDir: string, sessionId: string, action: string, nowTs: string): void {
  writeFileSync(join(claimDir, "claimed_by"), `${sessionId}\n`, "utf-8");
  writeFileSync(join(claimDir, "claimed_at"), `${nowTs}\n`, "utf-8");
  writeFileSync(join(claimDir, "action"), `${action}\n`, "utf-8");
}

/**
 * Attempt to claim `notification-id` for the given `sessionId`. Returns
 * `{claimed: true}` on success, otherwise `{claimed: false, owner, ageSec}`.
 *
 * Atomicity: uses `mkdir` (EEXIST) as the cross-process lock, matching
 * `status-manager.ts::cmdClaim`. We do NOT reach for `proper-lockfile`
 * here because the claim dir is durable state, not a transient barrier.
 */
export function tryClaim(options: ClaimOptions): ClaimResult {
  const { claimsDir, id, sessionId } = options;
  const staleSec = options.claimStaleSec ?? CLAIM_STALE_AFTER_SEC;
  const now = options.now ?? (() => new Date());
  const action = options.action ?? "dispatch";
  if (!existsSync(claimsDir)) mkdirSync(claimsDir, { recursive: true });
  const claimDir = join(claimsDir, id);

  let firstClaim = false;
  try {
    mkdirSync(claimDir);
    firstClaim = true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "EEXIST") {
      throw new Error(`failed to create claim dir "${claimDir}": ${e.message}`);
    }
  }

  const nowTs = formatUtcIso(now());
  if (firstClaim) {
    writeClaimBody(claimDir, sessionId, action, nowTs);
    return { claimed: true };
  }

  // Someone already owns the dir. Inspect `claimed_at`.
  const atPath = join(claimDir, "claimed_at");
  const ts = existsSync(atPath) ? parseIsoUtc(readFileSync(atPath, "utf-8")) : null;
  const ageSec = ts === null ? Number.POSITIVE_INFINITY : (now().getTime() - ts) / 1000;

  if (ageSec >= staleSec) {
    writeClaimBody(claimDir, sessionId, action, nowTs);
    return { claimed: true, ageSec };
  }

  let owner: string | undefined;
  const byPath = join(claimDir, "claimed_by");
  if (existsSync(byPath)) {
    owner = readFileSync(byPath, "utf-8").split("\n")[0]?.trim() || undefined;
  }
  return { claimed: false, owner, ageSec };
}

/**
 * Release a previously-held claim. Idempotent.
 */
export function releaseClaim(claimsDir: string, id: string): void {
  const claimDir = join(claimsDir, id);
  if (!existsSync(claimDir)) return;
  try {
    rmSync(claimDir, { recursive: true, force: true });
  } catch {
    /* ignore — the next claim attempt will clean it up */
  }
}

/**
 * Read-only: describe the current state of a claim without taking it.
 * Returns `null` when no claim exists.
 */
export function peekClaim(
  claimsDir: string,
  id: string,
): { owner: string; claimedAtMs: number; ageSec: number } | null {
  const claimDir = join(claimsDir, id);
  if (!existsSync(claimDir)) return null;
  const atPath = join(claimDir, "claimed_at");
  if (!existsSync(atPath)) return null;
  const ts = parseIsoUtc(readFileSync(atPath, "utf-8"));
  if (ts === null) return null;
  const byPath = join(claimDir, "claimed_by");
  const owner = existsSync(byPath)
    ? readFileSync(byPath, "utf-8").split("\n")[0]?.trim() ?? ""
    : "";
  const ageSec = (Date.now() - ts) / 1000;
  return { owner, claimedAtMs: ts, ageSec };
}

/**
 * Sweep the claims directory for entries older than the staleness
 * window. Matches `commands/poll.ts::cleanupExpiredClaims` but lives
 * here so the broker can invoke it on startup + after each dispatch
 * without reaching into commands/*.
 */
export function cleanupExpiredClaims(
  claimsDir: string,
  staleSec: number = CLAIM_STALE_AFTER_SEC,
  now: number = Date.now(),
): number {
  if (!existsSync(claimsDir)) return 0;
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(claimsDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const claimDir = join(claimsDir, name);
    try {
      const st = statSync(claimDir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const atPath = join(claimDir, "claimed_at");
    if (!existsSync(atPath)) continue;
    const ts = parseIsoUtc(readFileSync(atPath, "utf-8"));
    if (ts === null) continue;
    if ((now - ts) / 1000 >= staleSec) {
      try {
        rmSync(claimDir, { recursive: true, force: true });
        removed += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

