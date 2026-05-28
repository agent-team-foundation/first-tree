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
  // Payload shape comes from `tokenUsageEventPayload` (shared schema). We
  // narrow defensively — older clients pre-PR-637 won't emit this event at
  // all, but if a payload arrives with surprise shape we degrade silently
  // rather than crash the timeline.
  if (typeof event.payload !== "object" || event.payload === null) return null;
  const p = event.payload as {
    inputTokens?: unknown;
    cachedInputTokens?: unknown;
    outputTokens?: unknown;
    provider?: unknown;
    model?: unknown;
  };
  const input = typeof p.inputTokens === "number" ? p.inputTokens : 0;
  const cached = typeof p.cachedInputTokens === "number" ? p.cachedInputTokens : 0;
  const output = typeof p.outputTokens === "number" ? p.outputTokens : 0;
  const provider = typeof p.provider === "string" ? p.provider : "";
  const model = typeof p.model === "string" ? p.model : "";

  const total = input + cached + output;
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
