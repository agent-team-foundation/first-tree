/**
 * Append-only JSONL writer for `~/.breeze/activity.log`.
 *
 * Spec: `docs/migration/02-inbox-store-schema.md` §2.
 *
 * The Rust fetcher uses `read + full-rewrite` (`append_activity_events`,
 * fetcher.rs:633-650). We use a plain `appendFileSync` — functionally
 * equivalent for a single writer, and slightly safer against a crash
 * mid-write (POSIX `O_APPEND` writes of small buffers are effectively
 * atomic at the line level).
 *
 * No rotation yet — the Rust daemon doesn't rotate either. Phase 3 is
 * the natural place to introduce rotation; spec doc 2 §2.4 flags this.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

import { type ActivityEvent, ActivityEventSchema } from "./types.js";

function encodeEvent(event: ActivityEvent): string {
  // The bash status-manager uses `jq -nc` which preserves the order the
  // keys were listed. The Rust fetcher similarly emits keys in a fixed
  // order. To stay diff-friendly, we build each event's JSON manually
  // with a known order per kind.
  switch (event.event) {
    case "new":
      return JSON.stringify({
        ts: event.ts,
        event: event.event,
        id: event.id,
        type: event.type,
        repo: event.repo,
        title: event.title,
        url: event.url,
      });
    case "transition": {
      const payload: Record<string, unknown> = {
        ts: event.ts,
        event: event.event,
        id: event.id,
        type: event.type,
        repo: event.repo,
        title: event.title,
        url: event.url,
      };
      // The bash status-manager always writes `by` and `reason` (empty
      // strings when absent). The Rust fetcher writes neither. Preserve
      // whatever the caller passed in.
      if (event.by !== undefined) payload.by = event.by;
      if (event.reason !== undefined) payload.reason = event.reason;
      payload.from = event.from;
      payload.to = event.to;
      return JSON.stringify(payload);
    }
    case "claimed":
      return JSON.stringify({
        ts: event.ts,
        event: event.event,
        id: event.id,
        type: event.type,
        repo: event.repo,
        title: event.title,
        url: event.url,
        by: event.by,
        action: event.action,
      });
    case "poll":
      return JSON.stringify({
        ts: event.ts,
        event: event.event,
        count: event.count,
      });
  }
}

/**
 * Append one event as a single JSONL line. The file is created with a
 * trailing newline after every event. If the existing file is missing a
 * trailing newline (legacy state), prepend a `\n` to keep lines separated.
 */
export function appendActivityEvent(path: string, event: ActivityEvent): void {
  // Validate — refuse to write malformed events.
  ActivityEventSchema.parse(event);

  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  let prefix = "";
  if (existsSync(path)) {
    const size = statSync(path).size;
    if (size > 0) {
      // Cheap check: read only the last byte.
      const buf = Buffer.alloc(1);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buf, 0, 1, size - 1);
      } finally {
        closeSync(fd);
      }
      if (buf[0] !== 0x0a) prefix = "\n";
    }
  }
  appendFileSync(path, `${prefix}${encodeEvent(event)}\n`, "utf-8");
}

/**
 * Read the entire activity log as an array of parsed events.
 * Malformed lines are dropped (not thrown) — the log is append-only
 * and a partial tail from a crash would otherwise break consumers.
 */
export function readActivityLog(path: string): ActivityEvent[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const events: ActivityEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = ActivityEventSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) events.push(parsed.data);
    } catch {
      // Drop malformed lines — see fn comment.
    }
  }
  return events;
}
