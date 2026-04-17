/**
 * Read/write `~/.breeze/inbox.json` with atomic rename and cross-process
 * advisory locking.
 *
 * SINGLE-WRITER RULE (spec doc 2 §1.3):
 * -------------------------------------
 * Only a poller loop — the Rust `breeze-runner` fetcher, the TS daemon
 * poller at `daemon/poller.ts`, or the one-shot TS `commands/poll.ts` —
 * may call `writeInbox` directly with a full payload. All other callers
 * (`status-manager`, ad-hoc commands, this module's consumers, the
 * Phase 3b/3c http/broker/bus) must go through `updateInbox(mutator)`
 * which acquires the advisory lock, reads the current inbox, applies
 * `mutator`, and writes atomically. This rule keeps the notification
 * set authoritative in exactly one place.
 *
 * The lock is implemented with `proper-lockfile` (mkdir-style under the
 * hood, cross-process safe). Stale locks are reclaimed after 10s by
 * default; the inbox update path is fast (<100ms typically) so this is
 * generous.
 *
 * Atomicity: write-to-`.tmp` + `rename` — POSIX rename is atomic w.r.t.
 * concurrent readers, matching `write_inbox` in
 * `first-tree-breeze/breeze-runner/src/fetcher.rs:583-599`.
 *
 * Format compatibility: encoder emits every key for every entry in the
 * order the Rust `entry_to_json` does (fetcher.rs:601-631), using JSON
 * `null` for nullable fields. Readers use `zod` schema validation with
 * a loud error on malformed input (Phase 2a does not auto-heal).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { lock } from "proper-lockfile";

import {
  type Inbox,
  InboxSchema,
  type InboxEntry,
} from "./types.js";

/**
 * Read and validate `inbox.json`. Returns `null` if the file is absent
 * (a freshly-installed machine has no inbox yet). Throws on malformed
 * content — callers should surface the error, not auto-heal.
 */
export function readInbox(path: string): Inbox | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  if (raw.trim().length === 0) {
    throw new Error(`inbox.json at ${path} is empty`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`inbox.json at ${path} is not valid JSON: ${msg}`);
  }
  const result = InboxSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `inbox.json at ${path} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Serialize an inbox entry with the exact key order the Rust encoder uses
 * (`entry_to_json`, fetcher.rs:601-631). Matters for diff-friendliness
 * only — JSON readers are order-agnostic — but we preserve it to keep
 * live files identical across implementations.
 */
function serializeEntry(entry: InboxEntry): Record<string, unknown> {
  return {
    id: entry.id,
    type: entry.type,
    reason: entry.reason,
    repo: entry.repo,
    title: entry.title,
    url: entry.url,
    last_actor: entry.last_actor,
    updated_at: entry.updated_at,
    unread: entry.unread,
    priority: entry.priority,
    number: entry.number, // null preserved by JSON.stringify
    html_url: entry.html_url,
    gh_state: entry.gh_state,
    labels: entry.labels,
    breeze_status: entry.breeze_status,
  };
}

function serializeInbox(inbox: Inbox): string {
  const payload = {
    last_poll: inbox.last_poll,
    notifications: inbox.notifications.map(serializeEntry),
  };
  // The Rust encoder produces compact JSON (no internal whitespace). The
  // legacy bash poller produces pretty-printed JSON. Readers cope with
  // both (spec doc 2 §1.3); we emit compact to match the Rust writer.
  return JSON.stringify(payload);
}

/**
 * Atomically write `inbox.json` by writing `inbox.json.tmp` and
 * renaming. Intended for the daemon-writer path only; short-lived
 * callers should use `updateInbox`.
 */
export function writeInbox(path: string, inbox: Inbox): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serializeInbox(inbox), "utf-8");
  renameSync(tmp, path);
}

export interface UpdateInboxOptions {
  /** Path to `inbox.json`. */
  inboxPath: string;
  /**
   * Lock target. `proper-lockfile` requires the file (or lockfile path)
   * exist. We lock on `inbox.json` when it exists, otherwise on the
   * containing directory so first-write contention still serializes.
   */
  lockfilePath?: string;
  /** Lock stale-reclaim timeout in ms; default 10_000 (library default). */
  staleMs?: number;
  /** Retry schedule for lock acquisition; default 3 attempts w/ jitter. */
  retries?: number;
}

/**
 * Load → mutate → write under an advisory lock. The mutator receives
 * the current inbox (or `null` if none exists on disk) and returns the
 * new inbox, or `null` to abort without writing.
 */
export async function updateInbox(
  mutator: (current: Inbox | null) => Inbox | null,
  options: UpdateInboxOptions,
): Promise<Inbox | null> {
  const parent = dirname(options.inboxPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  // proper-lockfile needs the target to exist. If inbox.json hasn't been
  // created yet, lock on the parent directory; the directory is guaranteed
  // to exist after the mkdir above.
  const inboxExists = existsSync(options.inboxPath);
  const lockTarget = inboxExists ? options.inboxPath : parent;

  const release = await lock(lockTarget, {
    stale: options.staleMs ?? 10_000,
    retries: options.retries ?? { retries: 3, minTimeout: 25, maxTimeout: 200 },
    lockfilePath: options.lockfilePath ?? `${options.inboxPath}.lock`,
    realpath: false,
  });
  try {
    const current = readInbox(options.inboxPath);
    const next = mutator(current);
    if (next === null) return null;
    writeInbox(options.inboxPath, next);
    return next;
  } finally {
    await release();
  }
}
