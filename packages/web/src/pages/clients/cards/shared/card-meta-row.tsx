import type { ReactNode } from "react";
import type { HubClient } from "../../../../api/activity.js";
import { formatDate, formatRelative } from "../../../../lib/utils.js";

type CardMetaRowProps = {
  client: HubClient;
  /**
   * When true, render the heartbeat / first-tree / OS labels with reduced
   * opacity. Used by AuthExpired and Offline cards where the diagnostic
   * + action is the primary message and the meta fields are supporting
   * context (mockup §"Variant B" / §"B-3" show "last reported" prefix
   * on the same fields).
   */
  dimmed?: boolean;
  /** Trailing extra content (e.g. agents count). */
  trailing?: ReactNode;
};

/**
 * "Heartbeat / first-tree / OS / Agents" 4-field meta row shown at the
 * bottom (or under a divider) of every card. Same data points as the
 * old table's columns, just rearranged for the card form factor.
 *
 * The labels follow the column-header copy locked in PR-A:
 *   - "Heartbeat" (was "Last seen") — uses `formatRelative` so the
 *     value reads "12 sec ago" / "8 days ago"
 *   - "first-tree" — hub CLI version (NOT a per-provider runtime
 *     version)
 *   - "OS" — `client.os` raw value
 *
 * Cards are wider than table cells, so the rendering uses a flex row
 * with right-aligned values; on narrow viewports the row wraps cleanly
 * without truncation because each field is bounded.
 */
export function CardMetaRow({ client, dimmed = false, trailing }: CardMetaRowProps) {
  const opacity = dimmed ? 0.6 : 1;
  return (
    <div
      className="flex flex-col"
      style={{
        gap: "var(--sp-1_5)",
        fontSize: "var(--text-caption-size)",
        color: "var(--fg-3)",
        opacity,
      }}
    >
      <MetaLine label="Heartbeat" value={formatRelative(client.lastSeenAt)} title={formatDate(client.lastSeenAt)} />
      <MetaLine label="first-tree" value={client.sdkVersion ?? "—"} mono />
      <MetaLine label="OS" value={client.os ?? "—"} />
      {trailing}
    </div>
  );
}

function MetaLine({
  label,
  value,
  title,
  mono = false,
}: {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline" style={{ gap: "var(--sp-3)" }}>
      <span className="text-caption" style={{ minWidth: 96, color: "var(--fg-4)" }}>
        {label}
      </span>
      <span className={mono ? "mono text-caption" : "text-caption"} title={title}>
        {value}
      </span>
    </div>
  );
}
