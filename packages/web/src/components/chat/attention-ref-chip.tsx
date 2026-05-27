import { useMemo } from "react";

/**
 * Inline chip cluster that renders `att-XXXXXXXX` references found anywhere
 * inside a message body — the convention from proposal §5.1 ("agent 可发一
 * 条普通 chat message 引用 NHA，带 `att-xxxx` chip 做叙事"). Each chip is a
 * compact pill: clicking it scrolls the chat-bottom AttentionCard for that
 * NHA into view (the card carries `data-attention-id`). When the referenced
 * Attention is closed or off-screen this no-ops gracefully.
 *
 * Recognised pattern: `att-` followed by 8+ hex chars (UUIDv7 prefix). The
 * scan keeps a Set so the same id is shown only once per message.
 */

const REF_PATTERN = /\batt-([0-9a-f-]{8,})\b/g;

export function AttentionRefChips({ text }: { text: string | null | undefined }) {
  const ids = useMemo(() => extractAttentionRefs(text ?? ""), [text]);
  if (ids.length === 0) return null;
  return (
    <div
      className="flex items-center"
      style={{
        gap: "var(--sp-1)",
        flexWrap: "wrap",
        marginBottom: "var(--sp-1)",
      }}
    >
      {ids.map((id) => (
        <AttentionRefChip key={id} prefix={id} />
      ))}
    </div>
  );
}

function AttentionRefChip({ prefix }: { prefix: string }) {
  const onClick = () => {
    const el = document.querySelector(`[data-attention-id^="${prefix}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={`跳到请示 att-${prefix}`}
      className="mono text-caption inline-flex items-center transition-colors"
      style={{
        padding: "var(--sp-0_25) var(--sp-1_25)",
        background: "var(--bg-error-soft)",
        color: "var(--fg-error-strong)",
        borderRadius: "var(--radius-chip)",
        border: "var(--hairline) solid var(--fg-error-strong)",
        cursor: "pointer",
        textTransform: "uppercase",
      }}
    >
      ! att-{prefix.slice(0, 8)}
    </button>
  );
}

export function extractAttentionRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(REF_PATTERN)) {
    if (m[1]) out.add(m[1]);
  }
  return Array.from(out);
}
