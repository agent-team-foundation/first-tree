import type { Attention } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { attentionsInChatQueryKey, listAttentionsInChat } from "../../../api/attention.js";
import { useAuth } from "../../../auth/auth-context.js";
import { formatElapsed } from "../../../components/chat/working-chip.js";
import { Markdown } from "../../../components/ui/markdown.js";
import { useAgentNameMap } from "../../../lib/use-agent-name-map.js";

/**
 * Sidebar cap — the list shows at most this many rows. Per proposal §5.3
 * the sidebar is a quick at-a-glance summary, not a full audit surface;
 * older history can be reached via `first-tree attention list`.
 */
const SIDEBAR_MAX_ROWS = 5;

/**
 * Right-rail Attention section — one row per Attention bound to this chat.
 *
 * Per proposal §5.3 every row is a single-line summary; clicking opens a
 * popover anchored to the row instead of expanding inline. Rendering rules:
 *

 *   - Open request: clicking opens a portal popover anchored to the row.
 *     The popover is a read-only summary plus a "Go to chat" deep link —
 *     the authoritative response surface is the chat-bottom AttentionCard,
 *     not the sidebar (keeps respond submission flows in one place).
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
  const { agentId: myAgentId } = useAuth();
  const { data } = useQuery({
    queryKey: attentionsInChatQueryKey(chatId),
    queryFn: () => listAttentionsInChat(chatId),
    enabled: !!chatId,
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const all = data ?? [];
  // Strict relevance filter — only show attentions where THIS user is the
  // target. The server already restricts the list to attentions visible
  // to this user (target=me OR origin=my-managed-agent), but the sidebar
  // is the "what's on my plate" panel: limit further to target=me so the
  // viewer's own asks-out-to-others don't clutter their attention list.
  //
  // Display rule: the most recent SIDEBAR_MAX_ROWS rows (`createdAt` desc,
  // sliced). No "open at top" reorder — the badge shows the true open
  // count across all rows, so an open ask outside the visible slice is
  // still surfaced numerically. Users wanting the full audit list go to
  // `first-tree attention list --raised-by-me --state all`.
  const mine = useMemo(() => (myAgentId ? all.filter((a) => a.targetHumanId === myAgentId) : []), [all, myAgentId]);
  const sorted = useMemo(
    () => [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, SIDEBAR_MAX_ROWS),
    [mine],
  );
  // True open count across the relevance-filtered set (pre-slice). This is
  // what the user actually has on their plate; clamping the badge to the
  // visible window would silently under-report.
  const openCount = useMemo(() => mine.filter((a) => a.state === "open" && a.requiresResponse).length, [mine]);

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
              padding: "var(--sp-px) var(--sp-1)",
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
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const tagText = isOpenAsk ? "Ask" : isNotify ? "Notify" : "Closed";
  const tagColor = isOpenAsk ? "var(--fg-error-strong)" : attention.state === "closed" ? "var(--fg-3)" : "var(--fg-2)";

  return (
    <li>
      <button
        ref={buttonRef}
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
            padding: "var(--sp-px) var(--sp-1)",
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
      {active ? <AttentionPopover attention={attention} anchor={buttonRef.current} onClose={onClose} /> : null}
    </li>
  );
}

function AttentionPopover({
  attention,
  anchor,
  onClose,
}: {
  attention: Attention;
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const isOpenAsk = attention.state === "open" && attention.requiresResponse;
  const scrollToCard = () => {
    const el = document.querySelector(`[data-attention-id="${attention.id}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    onClose();
  };

  // Re-anchor on mount + on scroll / resize. We portal to document.body to
  // escape the sidebar's stacking context (the popover otherwise renders
  // behind the main-area chat header). `position: fixed` lets us track the
  // anchor by viewport coordinates without re-parenting math.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const reposition = () => {
      const rect = anchor.getBoundingClientRect();
      setPos({ top: rect.top, left: rect.left });
    };
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [anchor]);

  // Esc closes the popover (consistent with modal hygiene).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!pos) return null;

  const popover = (
    <div
      role="dialog"
      aria-label={`Attention ${attention.subject}`}
      style={{
        position: "fixed",
        top: pos.top,
        // Anchor LEFT of the row (sidebar sits on the right edge); the
        // popover's right edge stops `var(--sp-1)` short of the row's left.
        right: `calc(100vw - ${pos.left}px + var(--sp-1))`,
        width: "clamp(20rem, 28vw, 28rem)",
        maxHeight: "calc(100vh - var(--sp-4))",
        overflowY: "auto",
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        boxShadow: "var(--shadow-md)",
        padding: "var(--sp-2_5) var(--sp-3) var(--sp-3)",
        zIndex: 1000,
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
        aria-label="Close popover"
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
            Human reply
          </div>
          <div className="text-label" style={{ color: "var(--fg)" }}>
            <Markdown>{attention.response}</Markdown>
          </div>
        </div>
      ) : null}
      {attention.cancelled ? (
        <div className="text-caption" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1_5)" }}>
          Cancelled{attention.cancelledReason ? ` · ${attention.cancelledReason}` : ""}
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
          Go to chat ↓
        </button>
      ) : null}
    </div>
  );
  return createPortal(popover, document.body);
}

function useElapsed(iso: string): string {
  return formatElapsed(Date.now() - new Date(iso).getTime());
}
