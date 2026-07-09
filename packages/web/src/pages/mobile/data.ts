import type { MeChatRow } from "@first-tree/shared";

export type MobileChatSignalTone = "needs-you" | "error" | "unread" | "working" | "idle";

export type MobileChatSignal = {
  tone: MobileChatSignalTone;
  label: string;
  rank: number;
  attention: boolean;
};

export function mobileChatSignal(row: MeChatRow): MobileChatSignal {
  if (row.openRequestCount > 0) {
    return {
      tone: "needs-you",
      label: row.openRequestCount === 1 ? "Needs answer" : `${row.openRequestCount} questions`,
      rank: 0,
      attention: true,
    };
  }
  if (row.failedAgentIds.length > 0) {
    return {
      tone: "error",
      label: row.failedAgentIds.length === 1 ? "Failed" : `${row.failedAgentIds.length} failed`,
      rank: 1,
      attention: true,
    };
  }
  if (row.chatHasExplicitMentionToMe || row.unreadMentionCount > 0) {
    return {
      tone: "unread",
      label: row.unreadMentionCount === 1 ? "Unread" : `${row.unreadMentionCount} unread`,
      rank: 2,
      attention: true,
    };
  }
  if (row.busyAgentIds.length > 0 || row.liveActivity !== null) {
    return {
      tone: "working",
      label: row.liveActivity?.label ?? "Working",
      rank: 3,
      attention: false,
    };
  }
  return {
    tone: "idle",
    label: row.membershipKind === "watching" ? "Watching" : "Recent",
    rank: 4,
    attention: false,
  };
}

export function mobileChatPreview(row: MeChatRow): string {
  return row.description?.trim() || row.lastMessagePreview?.trim() || "No messages yet.";
}

export function sortMobileChats(rows: readonly MeChatRow[]): MeChatRow[] {
  return [...rows].sort((a, b) => {
    const signalDelta = mobileChatSignal(a).rank - mobileChatSignal(b).rank;
    if (signalDelta !== 0) return signalDelta;
    return timestampValue(b.lastMessageAt) - timestampValue(a.lastMessageAt);
  });
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
