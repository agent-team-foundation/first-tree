/**
 * WorkingChip — live activity indicator surfaced in the chat-row time slot.
 *
 * Replaces the static `lastMessageAt` time when the server reports a
 * `liveActivity` for the chat. Derived from the latest `session_events`
 * row for the (agent, chat) pair on the server; the server already drops
 * terminal events (`turn_end` / `error`) and stale events (>60s old).
 *
 * Three visual atoms:
 *   - Pulsing dot (1s cadence — faster than the avatar ring's 1.6s, so
 *     the two motions read as distinct).
 *   - Activity label (`Read`, `Thinking`, `Writing`, …).
 *   - Ticker showing the wall-clock seconds since `startedAt`. The
 *     ticker is local-only (no network) and self-clears via the parent's
 *     re-render when `liveActivity` flips to null.
 *
 * The chip is intentionally typography-only — no border, no background —
 * so the row's hover affordance (the ⋯ trigger that takes over this
 * slot) still reads as the primary actionable target.
 */

import type { LiveActivity } from "@agent-team-foundation/first-tree-hub-shared";
import { useEffect, useState } from "react";

const TICK_INTERVAL_MS = 1000;

/** Render a compact "0.4s" / "12s" / "1m23s" string. Exported for tests. */
export function formatElapsed(ms: number): string {
  if (ms < 0) return "0s";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

export function WorkingChip({ activity }: { activity: LiveActivity }) {
  // Ticker — re-render every second so the elapsed string moves forward.
  // The interval is mount-once; when a new live event arrives the parent
  // re-renders with a fresh `activity.startedAt`, and the next derivation
  // of `elapsed` below naturally reflects the new origin (no explicit
  // restart needed since the interval only schedules `setNow` ticks).
  const startedAt = new Date(activity.startedAt).getTime();
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const elapsed = formatElapsed(now - startedAt);

  return (
    <span
      role="status"
      aria-label={`${activity.label}, ${elapsed}`}
      className="mono text-caption shrink-0 inline-flex items-center"
      style={{ gap: 6, color: "var(--state-working)" }}
    >
      <span
        aria-hidden="true"
        className="chat-row-live-chip__dot"
        style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "var(--state-working)",
        }}
      />
      <span className="truncate" style={{ maxWidth: 96 }}>
        {activity.label}
      </span>
      <span style={{ color: "var(--fg-4)" }}>{elapsed}</span>
    </span>
  );
}
