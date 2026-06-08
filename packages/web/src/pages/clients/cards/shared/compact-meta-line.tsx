import type { HubClient } from "../../../../api/activity.js";
import { formatDate, formatRelative } from "../../../../lib/utils.js";
import { formatOfflineDuration } from "../view-models.js";

/**
 * Single-line meta summary that replaces the `<dl>` grid from the
 * earlier `CardMetaRow`. Renders one line with a time segment +
 * version + OS, separated by mid-dots:
 *
 *   Heartbeat 7 seconds ago · 0.5.3-staging.49.1 · darwin   (Ready / SetupIncomplete)
 *   Last seen 2 days ago · 0.5.2-staging · darwin           (Offline)
 *   Hasn't checked in for 8 days · 0.5.1 · darwin           (AuthExpired)
 *
 * The `timeMode` prop picks the leading time segment so the card
 * body's only "what happened" line lives here — the per-pill body
 * doesn't need a separate diagnostic `<p>` anymore. The pill (red
 * "Auth expired" / grey "Offline" / green "Ready") + this line
 * together carry the state.
 *
 * When the relevant timestamp is unparseable, the time segment is
 * skipped gracefully; if version and os are also absent, the whole
 * line renders nothing (no orphan hairline above an empty caption).
 */
export type CompactMetaTimeMode = "heartbeat" | "offline" | "auth-expired" | "none";

export function CompactMetaLine({
  client,
  dimmed = false,
  timeMode = "heartbeat",
}: {
  client: HubClient;
  /** Reduce opacity — used when the meta is stale context (offline/expired). */
  dimmed?: boolean;
  /**
   * Which time-segment phrasing to use:
   *   - `heartbeat`: "Heartbeat 7 seconds ago" — Ready / SetupIncomplete (no diagnostic sentence above)
   *   - `offline`: "Last seen 2 days ago" — Offline
   *   - `auth-expired`: "Hasn't checked in for 8 days" — AuthExpired
   *   - `none`: skip the time segment entirely (rarely useful, only when caller renders time elsewhere)
   */
  timeMode?: CompactMetaTimeMode;
}) {
  const timeSegment = buildTimeSegment(client, timeMode);
  const segments: string[] = [];
  if (timeSegment) segments.push(timeSegment);
  // "first-tree " prefix makes the version segment self-describing —
  // without it the bare "0.5.3-staging.49.1" reads as an opaque
  // identifier with no hint that it's the First Tree CLI version.
  if (client.sdkVersion) segments.push(`first-tree ${client.sdkVersion}`);
  if (client.os) segments.push(client.os);
  if (client.serverCommandVersion) {
    segments.push(`Update available ${client.serverCommandVersion}`);
  }
  if (segments.length === 0) return null;
  return (
    <div
      className="text-caption"
      style={{ color: "var(--fg-3)", opacity: dimmed ? 0.85 : 1 }}
      title={formatDate(client.lastSeenAt)}
    >
      {segments.join(" · ")}
    </div>
  );
}

function buildTimeSegment(client: HubClient, mode: CompactMetaTimeMode): string | null {
  if (mode === "none") return null;
  if (mode === "heartbeat") {
    const rel = formatRelative(client.lastSeenAt);
    return rel ? `Heartbeat ${rel}` : null;
  }
  if (mode === "offline") {
    const dur = formatOfflineDuration(client.lastSeenAt);
    return dur ? `Last seen ${dur} ago` : "Last seen recently";
  }
  // auth-expired
  const dur = formatOfflineDuration(client.lastSeenAt);
  return dur ? `Hasn't checked in for ${dur}` : "Hasn't checked in recently";
}
