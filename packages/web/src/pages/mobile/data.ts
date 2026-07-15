import type { ListMeChatsResponse, MeChatRow } from "@first-tree/shared";
import { stripInlineMarkdown } from "../../lib/strip-inline-markdown.js";
import { rowAttentionReason } from "../workspace/conversations/group-rows.js";

export type MobileChatSignalTone = "needs-you" | "error" | "unread" | "working" | "idle";

export type MobileChatSignal = {
  tone: MobileChatSignalTone;
  label: string;
  rank: number;
  attention: boolean;
};

export function mobileChatSignal(row: MeChatRow): MobileChatSignal {
  const attentionReason = rowAttentionReason(row);
  if (attentionReason === "failed") {
    return {
      tone: "error",
      label: row.failedAgentIds.length === 1 ? "Run failed" : `${row.failedAgentIds.length} runs failed`,
      rank: 0,
      attention: true,
    };
  }
  if (attentionReason === "request") {
    return {
      tone: "needs-you",
      label: row.openRequestCount === 1 ? "Needs your answer" : `${row.openRequestCount} questions`,
      rank: 1,
      attention: true,
    };
  }
  if (row.chatHasExplicitMentionToMe || row.unreadMentionCount > 0) {
    return {
      tone: "unread",
      label:
        row.unreadMentionCount === 0 || row.unreadMentionCount === 1 ? "Unread" : `${row.unreadMentionCount} unread`,
      rank: 2,
      attention: false,
    };
  }
  if (row.busyAgentIds.length > 0 || row.liveActivity !== null) {
    return {
      tone: "working",
      label: row.liveActivity?.label ?? "Working now",
      rank: 2,
      attention: false,
    };
  }
  return {
    tone: "idle",
    label: row.membershipKind === "watching" ? "Watching" : "Recent",
    rank: 2,
    attention: false,
  };
}

/** Keep the complete Chat list's established, quieter status language. */
export function mobileChatListSignal(row: MeChatRow): MobileChatSignal {
  const signal = mobileChatSignal(row);
  switch (signal.tone) {
    case "error":
      return { ...signal, label: row.failedAgentIds.length === 1 ? "Failed" : `${row.failedAgentIds.length} failed` };
    case "needs-you":
      return { ...signal, label: row.openRequestCount === 1 ? "Needs answer" : `${row.openRequestCount} questions` };
    case "working":
      return { ...signal, label: row.liveActivity?.label ?? "Working" };
    case "unread":
    case "idle":
      return signal;
  }
}

export function mobileChatPreview(row: MeChatRow): string {
  const raw = row.description?.trim() || row.lastMessagePreview?.trim();
  // Card previews are a one-line glance, not a rendered surface: peel inline
  // markdown so `**Task:**` / `` `code` `` don't leak their literal markers.
  // Fall back on the *stripped* value — a preview that is only markup (e.g. an
  // `![](url)` image) strips to empty and must show the placeholder, not blank.
  const stripped = raw ? stripInlineMarkdown(raw) : "";
  return stripped || "No messages yet.";
}

const AGE_MINUTE_MS = 60_000;
const AGE_HOUR_MS = 3_600_000;
const AGE_DAY_MS = 86_400_000;
const AGE_WEEK_MS = 7 * AGE_DAY_MS;
const AGE_MONTH_MS = 30 * AGE_DAY_MS;

/**
 * Ultra-compact age for the attention feed: "now", "5m", "3h", "4d", "2w",
 * "3mo". Unlike `formatRowTime`, it never falls back to an absolute `MM/DD`
 * date — on a needs-attention surface, how long a question has been waiting
 * or a failure has sat unhandled is itself the signal; a dead date reads as
 * neither urgent nor stale. Returns "" for null/invalid input so the card
 * simply omits the slot.
 */
export function formatMobileAge(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const age = Date.now() - t;
  if (age < AGE_MINUTE_MS) return "now";
  if (age < AGE_HOUR_MS) return `${Math.floor(age / AGE_MINUTE_MS)}m`;
  if (age < AGE_DAY_MS) return `${Math.floor(age / AGE_HOUR_MS)}h`;
  if (age < AGE_WEEK_MS) return `${Math.floor(age / AGE_DAY_MS)}d`;
  if (age < AGE_MONTH_MS) return `${Math.floor(age / AGE_WEEK_MS)}w`;
  return `${Math.floor(age / AGE_MONTH_MS)}mo`;
}

/**
 * Materialize the server's complete attention projection for Now and tab
 * badges. Mobile does not expose pinning, so priority-only pinned rows do not
 * enter its finite lists; the additive recency page still supplies ordinary
 * rows and the result is de-duplicated by chat id.
 */
export function mobileRowsFromList(data: ListMeChatsResponse | undefined): MeChatRow[] {
  if (!data) return [];
  const seen = new Set<string>();
  return [...data.priorityRows.attention, ...data.rows].filter((row) => {
    if (seen.has(row.chatId)) return false;
    seen.add(row.chatId);
    return true;
  });
}

export function sortMobileChats(rows: readonly MeChatRow[]): MeChatRow[] {
  return [...rows].sort((a, b) => {
    const signalA = mobileChatSignal(a);
    const signalB = mobileChatSignal(b);
    const signalDelta = signalA.rank - signalB.rank;
    if (signalDelta !== 0) return signalDelta;
    return timestampValue(b.activityAt ?? b.lastMessageAt) - timestampValue(a.activityAt ?? a.lastMessageAt);
  });
}

/** Preserve the pre-refresh ordering of the complete Chat list. */
export function sortMobileChatList(rows: readonly MeChatRow[]): MeChatRow[] {
  return [...rows].sort((a, b) => {
    const signalDelta = mobileChatSignal(a).rank - mobileChatSignal(b).rank;
    if (signalDelta !== 0) return signalDelta;
    return timestampValue(b.lastMessageAt) - timestampValue(a.lastMessageAt);
  });
}

/**
 * Now feed admission. A chat enters the needs-attention feed only when it
 * carries an AUTHORITATIVE active signal, read from the source-of-truth fields
 * rather than the display `mobileChatSignal` tone:
 *   - a caller-managed failed agent (`failedAgentIds`);
 *   - an open request directed at the caller (`openRequestCount`);
 *   - an explicit `@me` mention (`chatHasExplicitMentionToMe`) — NOT the
 *     broader `unreadMentionCount`, which also counts the implicit 1:1 DM
 *     auto-mention, so a plain unread reply does not qualify;
 *   - an in-flight turn (`busyAgentIds`) — NOT `liveActivity`, which is a
 *     descriptive label the session-status contract allows to linger after the
 *     authoritative busy projection is already false.
 * `idle` / watching-only chats stay in the Chat tab, not Now.
 */
export function isNowFeedRow(row: MeChatRow): boolean {
  return (
    row.failedAgentIds.length > 0 ||
    row.openRequestCount > 0 ||
    row.chatHasExplicitMentionToMe ||
    row.busyAgentIds.length > 0
  );
}

export function countAttentionRows(rows: readonly MeChatRow[]): number {
  return rows.reduce((total, row) => total + (mobileChatSignal(row).attention ? 1 : 0), 0);
}

export function countUnreadRows(rows: readonly MeChatRow[]): number {
  return rows.reduce((total, row) => total + (row.unreadMentionCount > 0 ? 1 : 0), 0);
}

function timestampValue(iso: string | null): number {
  if (!iso) return 0;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}
