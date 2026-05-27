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
 * "Heartbeat / first-tree / OS" meta block. Rendered as a `<dl>` so the
 * label/value pairing is semantically explicit, with a 2-column grid for
 * visual alignment. This matches the Settings tab's field-value rhythm
 * used in /settings/github and /settings/messaging.
 *
 * Labels follow the copy locked in PR-A:
 *   - "Heartbeat" — `formatRelative(lastSeenAt)`, e.g. "12 sec ago"
 *   - "first-tree" — hub CLI version (NOT a per-provider runtime version)
 *   - "OS" — `client.os` raw value
 */
export function CardMetaRow({ client, dimmed = false, trailing }: CardMetaRowProps) {
  const opacity = dimmed ? 0.65 : 1;
  return (
    <dl
      style={{
        margin: 0,
        display: "grid",
        gridTemplateColumns: "max-content 1fr",
        columnGap: "var(--sp-4)",
        rowGap: "var(--sp-1)",
        opacity,
      }}
    >
      <MetaEntry label="Heartbeat" value={formatRelative(client.lastSeenAt)} title={formatDate(client.lastSeenAt)} />
      <MetaEntry label="first-tree" value={client.sdkVersion ?? "—"} mono />
      <MetaEntry label="OS" value={client.os ?? "—"} />
      {trailing}
    </dl>
  );
}

function MetaEntry({
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
    <>
      <dt className="text-caption" style={{ color: "var(--fg-3)" }}>
        {label}
      </dt>
      <dd
        className={mono ? "mono text-caption" : "text-caption"}
        style={{ margin: 0, color: "var(--fg-2)" }}
        title={title}
      >
        {value}
      </dd>
    </>
  );
}
