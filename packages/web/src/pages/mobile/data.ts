import type { MeChatRow } from "@first-tree/shared";
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
      label: row.failedAgentIds.length === 1 ? "Failed" : `${row.failedAgentIds.length} failed`,
      rank: 0,
      attention: true,
    };
  }
  if (attentionReason === "request") {
    return {
      tone: "needs-you",
      label: row.openRequestCount === 1 ? "Needs answer" : `${row.openRequestCount} questions`,
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
      label: row.liveActivity?.label ?? "Working",
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

export function mobileChatPreview(row: MeChatRow): string {
  const raw = row.description?.trim() || row.lastMessagePreview?.trim();
  // Card previews are a one-line glance, not a rendered surface: peel inline
  // markdown so `**Task:**` / `` `code` `` don't leak their literal markers.
  // Fall back on the *stripped* value — a preview that is only markup (e.g. an
  // `![](url)` image) strips to empty and must show the placeholder, not blank.
  const stripped = raw ? stripInlineMarkdown(raw) : "";
  return stripped || "No messages yet.";
}

export function mobileFeedReasonLabel(row: MeChatRow): string {
  const attentionReason = rowAttentionReason(row);
  if (attentionReason === "failed") {
    return row.failedAgentIds.length === 1 ? "Failed run" : `${row.failedAgentIds.length} failed runs`;
  }
  if (attentionReason === "request") {
    if (row.openRequestCount === 1) {
      return "Question waiting";
    }
    return `${row.openRequestCount} questions waiting`;
  }
  if (row.chatHasExplicitMentionToMe || row.unreadMentionCount > 0) {
    return row.unreadMentionCount > 1 ? `${row.unreadMentionCount} unread mentions` : "Unread mention";
  }
  if (row.busyAgentIds.length > 0 || row.liveActivity !== null) {
    return "Working now";
  }
  if (row.membershipKind === "watching") {
    return "Watching";
  }
  return "Recent update";
}

export function sortMobileChats(rows: readonly MeChatRow[]): MeChatRow[] {
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
