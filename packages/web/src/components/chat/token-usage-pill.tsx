import type { SessionEventRow } from "../../api/sessions.js";
import { formatCompactCount } from "../../lib/utils.js";

/**
 * Per-turn token-usage pill rendered inline in the chat timeline.
 *
 * Sociocurrency + audit principle (see token-usage design doc v4): every
 * agent reply gets a small, always-on cost stamp. Hovering shows the full
 * breakdown so disputes ("why was that turn so expensive?") have an
 * immediate evidence pointer without leaving the chat.
 *
 * The pill is intentionally subdued — caption-sized, low-contrast — so
 * it never competes with the assistant message body. Operators looking
 * for spend are already looking; everyone else mostly scrolls past it.
 */
export function TokenUsagePill({ event }: { event: SessionEventRow }): React.ReactElement | null {
  // Payload shape comes from `tokenUsageEventPayload` (shared schema). The
  // pill is an audit primitive — "this turn cost N tokens" — so we fail
  // closed: any missing-or-wrong-type field hides the pill entirely rather
  // than rendering a placeholder zero. Silent zeros would read as "this
  // turn was free", polluting the audit trail (review nit R2).
  if (typeof event.payload !== "object" || event.payload === null) return null;
  const p = event.payload as {
    inputTokens?: unknown;
    cachedInputTokens?: unknown;
    outputTokens?: unknown;
    provider?: unknown;
    model?: unknown;
  };
  if (
    typeof p.inputTokens !== "number" ||
    typeof p.cachedInputTokens !== "number" ||
    typeof p.outputTokens !== "number"
  ) {
    return null;
  }
  const input = p.inputTokens;
  const cached = p.cachedInputTokens;
  const output = p.outputTokens;
  const provider = typeof p.provider === "string" ? p.provider : "";
  const model = typeof p.model === "string" ? p.model : "";

  const total = input + cached + output;
  // A turn that genuinely reported zero tokens across all three buckets is
  // not a real turn we want to flag — drop the pill rather than render a
  // misleading "0 tokens" badge.
  if (total === 0) return null;
  const title = [
    `${provider}${model ? `/${model}` : ""}`,
    `Input ${input.toLocaleString()}`,
    `Cached ${cached.toLocaleString()}`,
    `Output ${output.toLocaleString()}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex justify-end" style={{ padding: "var(--sp-0_5) var(--sp-5)" }}>
      <span
        className="text-caption mono inline-flex items-center"
        style={{
          gap: "var(--sp-1)",
          padding: "var(--sp-0_5) var(--sp-2)",
          color: "var(--fg-4)",
          background: "var(--bg-sunken)",
          borderRadius: "var(--hairline)",
        }}
        title={title}
      >
        <span>{formatCompactCount(total)}</span>
        <span style={{ color: "var(--fg-4)" }}>tokens</span>
      </span>
    </div>
  );
}
