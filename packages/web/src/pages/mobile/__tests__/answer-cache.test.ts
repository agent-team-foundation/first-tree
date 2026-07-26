import type { ListMeChatsResponse, MeChatRow, Message } from "@first-tree/shared";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { commitMobileAskResolution, locallyResolvedRequestIds, mobileResolvedRequestKey } from "../answer-cache.js";

const row: MeChatRow = {
  chatId: "chat-1",
  type: "group",
  membershipKind: "participant",
  createdByMe: false,
  source: "manual",
  entityType: null,
  title: "Pinned request",
  topic: "Pinned request",
  description: null,
  participants: [],
  participantCount: 2,
  lastMessageAt: "2026-07-14T10:00:00.000Z",
  lastMessagePreview: "Choose one",
  unreadMentionCount: 0,
  openRequestCount: 1,
  canReply: true,
  engagementStatus: "active",
  liveActivity: null,
  failedAgentIds: [],
  busyAgentIds: [],
  chatHasExplicitMentionToMe: false,
  pinnedAt: "2026-07-14T09:00:00.000Z",
  activityAt: "2026-07-14T10:00:00.000Z",
};

const request = {
  id: "request-1",
  chatId: row.chatId,
  senderId: "agent-1",
  format: "request",
  content: "Choose one",
  metadata: {},
  inReplyTo: null,
  source: "web",
  createdAt: "2026-07-14T10:00:00.000Z",
} satisfies Message;

describe("mobile answer cache", () => {
  it("tombstones the request and synchronously demotes its mobile list projection", async () => {
    const queryClient = new QueryClient();
    const listKey = ["me", "chats", "mobile", "now"];
    const list: ListMeChatsResponse = {
      priorityRows: { attention: [row], pinned: [] },
      rows: [row],
      nextCursor: null,
    };
    queryClient.setQueryData(["chat-open-requests", row.chatId], { items: [request] });
    queryClient.setQueryData(listKey, list);

    await commitMobileAskResolution(queryClient, row.chatId, request.id);

    expect(queryClient.getQueryData(mobileResolvedRequestKey(row.chatId))).toEqual([request.id]);
    expect(locallyResolvedRequestIds(queryClient, row.chatId).has(request.id)).toBe(true);
    expect(queryClient.getQueryData<{ items: Message[] }>(["chat-open-requests", row.chatId])?.items).toEqual([]);
    const patched = queryClient.getQueryData<ListMeChatsResponse>(listKey);
    expect(patched?.priorityRows.attention).toEqual([]);
    expect(patched?.priorityRows.pinned).toEqual([{ ...row, openRequestCount: 0 }]);
    expect(patched?.rows[0]?.openRequestCount).toBe(0);
  });
});
