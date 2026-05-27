import type { Attention } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { attentionsInChatQueryKey, listAttentionsInChat } from "../../../api/attention.js";
import { formatElapsed } from "../../../components/chat/working-chip.js";
import { Markdown } from "../../../components/ui/markdown.js";
import { useAgentNameMap } from "../../../lib/use-agent-name-map.js";

/**
 * Right-rail Attention section — one row per Attention bound to this chat.
 *
 * Per proposal §5.3 every row is a single-line summary; clicking opens a
 * popover anchored to the row instead of expanding inline. Rendering rules:
 *
 *   - Open request: row says "在底部展开中" / "已折叠"; clicking opens a
 *     popover that just points the human at the chat-bottom card (the
 *     authoritative response surface is the AttentionCard, not the
 *     sidebar — keeps respond submission flows in one place).
 *   - Notification (always closed on creation): row plus popover show the
 *     body markdown; no action.
 *   - Closed request: read-only summary in the popover (subject + body +
 *     response).
 *
 * The list query reuses the same `attentionsInChatQueryKey(chatId)` that
 * the chat-bottom card subscribes to, so admin WS invalidations propagate
 * to both surfaces at once.
 */
export function AttentionsSection({ chatId }: { chatId: string }) {
  const { data } = useQuery({
    queryKey: attentionsInChatQueryKey(chatId),
    queryFn: () => listAttentionsInChat(chatId),
    enabled: !!chatId,
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const all = data ?? [];
  // Newest first; open requests float to the top so the most recent
  // actionable item is one scroll away.
  const sorted = useMemo(() => {
    return [...all].sort((a, b) => {
      const aOpen = a.state === "open" && a.requiresResponse ? 0 : 1;
      const bOpen = b.state === "open" && b.requiresResponse ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [all]);
  const openCount = sorted.filter((a) => a.state === "open" && a.requiresResponse).length;

  if (sorted.length === 0) return null;

  return (
    <div style={{ padding: "var(--sp-3) var(--sp-3) var(--sp-2)" }}>
      <div
        className="text-eyebrow"
        style={{
          color: "var(--fg-3)",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          marginBottom: "var(--sp-1_5)",
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-1_5)",
        }}
      >
        Attention
        {openCount > 0 ? (
          <span
            className="mono"
            style={{
              padding: "var(--sp-0_25) var(--sp-1)",
              borderRadius: "var(--radius-chip)",
              background: "var(--fg-error-strong)",
              color: "var(--fg-on-vivid)",
              fontWeight: 600,
            }}
          >
            {openCount}
          </span>
        ) : null}
      </div>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-1)",
        }}
      >
        {sorted.map((att) => (
          <AttentionRow
            key={att.id}
            attention={att}
            active={openId === att.id}
            onOpen={() => setOpenId(att.id)}
            onClose={() => setOpenId(null)}
          />
        ))}
      </ul>
    </div>
  );
}

function AttentionRow({
  attention,
  active,
  onOpen,
  onClose,
}: {
  attention: Attention;
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const agentName = useAgentNameMap();
  const fromName = agentName(attention.originAgentId);
  const isOpenAsk = attention.state === "open" && attention.requiresResponse;
  const isNotify = !attention.requiresResponse;
  const elapsed = useElapsed(attention.createdAt);

  const tagText = isOpenAsk ? "请示" : isNotify ? "通报" : "已关闭";
  const tagColor = isOpenAsk ? "var(--fg-error-strong)" : attention.state === "closed" ? "var(--fg-3)" : "var(--fg-2)";

  return (
    <li style={{ position: "relative" }}>
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left transition-colors"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-1_5)",
          padding: "var(--sp-1_25) var(--sp-1_75)",
          background: active ? "var(--bg-sunken)" : "var(--bg-raised)",
          border: `var(--hairline) solid ${isOpenAsk ? "var(--fg-error-strong)" : "var(--border)"}`,
          borderRadius: "var(--radius-input)",
          cursor: "pointer",
          minWidth: 0,
        }}
      >
        <span
          className="mono text-caption"
          style={{
            padding: "var(--sp-0_25) var(--sp-1)",
            borderRadius: "var(--radius-chip)",
            background: isOpenAsk ? "var(--bg-error-soft)" : "var(--bg-sunken)",
            color: tagColor,
            flexShrink: 0,
          }}
        >
          {tagText}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            className="text-label font-semibold"
            style={{
              display: "block",
              color: "var(--fg)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {attention.subject}
          </span>
          <span className="mono text-caption" style={{ color: "var(--fg-3)" }}>
            {fromName} · {elapsed}
          </span>
        </span>
        <span className="text-caption" style={{ color: "var(--fg-4)", flexShrink: 0 }}>
          ↗
        </span>
      </button>
      {active ? <AttentionPopover attention={attention} onClose={onClose} /> : null}
    </li>
  );
}

function AttentionPopover({ attention, onClose }: { attention: Attention; onClose: () => void }) {
  const isOpenAsk = attention.state === "open" && attention.requiresResponse;
  const scrollToCard = () => {
    const el = document.querySelector(`[data-attention-id="${attention.id}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    onClose();
  };
  return (
    <div
      role="dialog"
      aria-label={`Attention ${attention.subject}`}
      style={{
        position: "absolute",
        right: "calc(100% + var(--sp-1))",
        top: 0,
        width: "clamp(20rem, 28vw, 28rem)",
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        boxShadow: "var(--shadow-lg)",
        padding: "var(--sp-2_5) var(--sp-3) var(--sp-3)",
        zIndex: 10,
      }}
    >
      <div
        className="text-subtitle font-semibold"
        style={{ color: "var(--fg)", marginBottom: "var(--sp-1_5)", paddingRight: "var(--sp-4)" }}
      >
        {attention.subject}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭浮窗"
        className="transition-colors"
        style={{
          position: "absolute",
          top: "var(--sp-1)",
          right: "var(--sp-1_5)",
          background: "transparent",
          border: 0,
          cursor: "pointer",
          color: "var(--fg-3)",
          fontSize: "var(--sp-3)",
          lineHeight: 1,
          padding: "var(--sp-0_5) var(--sp-1)",
        }}
      >
        ×
      </button>
      {attention.body ? (
        <div className="text-label" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-2)" }}>
          <Markdown>{attention.body}</Markdown>
        </div>
      ) : null}
      {attention.response ? (
        <div
          style={{
            background: "var(--bg-sunken)",
            border: "var(--hairline) solid var(--border-faint)",
            borderRadius: "var(--radius-input)",
            padding: "var(--sp-1_5) var(--sp-2)",
            marginBottom: "var(--sp-2)",
          }}
        >
          <div className="mono text-caption" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-0_5)" }}>
            人类回复
          </div>
          <div className="text-label" style={{ color: "var(--fg)" }}>
            <Markdown>{attention.response}</Markdown>
          </div>
        </div>
      ) : null}
      {attention.cancelled ? (
        <div className="text-caption" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1_5)" }}>
          已取消{attention.cancelledReason ? ` · ${attention.cancelledReason}` : ""}
        </div>
      ) : null}
      {isOpenAsk ? (
        <button
          type="button"
          onClick={scrollToCard}
          className="text-body font-medium inline-flex items-center justify-center"
          style={{
            padding: "var(--sp-1) var(--sp-2_5)",
            borderRadius: "var(--radius-input)",
            background: "var(--fg)",
            color: "var(--bg-raised)",
            border: 0,
            cursor: "pointer",
          }}
        >
          去底部回应 ↓
        </button>
      ) : null}
    </div>
  );
}

function useElapsed(iso: string): string {
  return formatElapsed(Date.now() - new Date(iso).getTime());
}
