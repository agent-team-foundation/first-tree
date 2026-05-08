import type { MeChatRow } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { getChat } from "../../../api/chats.js";
import { joinMeChat, listMeChats, markMeChatRead } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { ChatView } from "./chat-view.js";

/**
 * Chat-id-only shim around `ChatView`. The chat-first workspace navigates
 * by `chatId`, but the existing `ChatView` still wants an `agentId` for
 * session-level controls (suspend/terminate, runtime label). We pick a
 * "primary agent" from the chat's participants:
 *
 *   1. The first non-self, non-human participant (the conversation's
 *      autonomous/personal agent).
 *   2. Fallback: the first non-self participant.
 *
 * Mark-read fires once per chat on mount. Watching chats render the
 * timeline only — composer is replaced with `Join to reply`.
 */

function findRowAcrossFilters(qcRows: MeChatRow[] | undefined, chatId: string): MeChatRow | null {
  if (!qcRows) return null;
  return qcRows.find((r) => r.chatId === chatId) ?? null;
}

function pickPrimaryAgent(participants: { agentId: string; type?: string }[], myAgentId: string | null): string | null {
  const nonSelf = participants.filter((p) => p.agentId !== myAgentId);
  const nonHuman = nonSelf.find((p) => p.type !== undefined && p.type !== "human");
  if (nonHuman) return nonHuman.agentId;
  return nonSelf[0]?.agentId ?? null;
}

export function ChatByIdView({ chatId }: { chatId: string }) {
  const queryClient = useQueryClient();
  const { agentId: myAgentId } = useAuth();
  /**
   * Track the (chatId, lastMessageAt) pair we've already mark-read'd in this
   * mount. Re-marking on chat re-entry is necessary when new mentions
   * arrived between A → B → A, otherwise the unread dot stays. We key on
   * the row's `lastMessageAt` so a fresh message bumps the entry and the
   * next mount of this chat fires mark-read again.
   */
  const markedRef = useRef<Map<string, string>>(new Map());

  // Load the canonical chat detail for participant membership. ChatDetail
  // doesn't include `type`, so we cross-reference with `/me/chats` rows to
  // find a non-human primary.
  const { data: chatDetail } = useQuery({
    queryKey: ["chat-detail", chatId],
    queryFn: () => getChat(chatId),
    enabled: !!chatId,
  });

  // Pull the user's chat list to (a) decide membership (participant vs
  // watching) and (b) read participant `type` annotations the admin chat
  // detail doesn't expose. We try the `all` filter first since it is the
  // hot-list the conversation list also uses.
  const { data: allChats } = useQuery({
    queryKey: ["me", "chats", "all"] as const,
    queryFn: () => listMeChats({ filter: "all" }),
    refetchInterval: 30_000,
  });

  const { data: watchingChats } = useQuery({
    queryKey: ["me", "chats", "watching"] as const,
    queryFn: () => listMeChats({ filter: "watching" }),
    refetchInterval: 30_000,
  });

  const meRow: MeChatRow | null = useMemo(() => {
    return findRowAcrossFilters(allChats?.rows, chatId) ?? findRowAcrossFilters(watchingChats?.rows, chatId) ?? null;
  }, [allChats, watchingChats, chatId]);

  const participantsForPrimary = useMemo(() => {
    if (meRow) return meRow.participants.map((p) => ({ agentId: p.agentId, type: p.type }));
    if (chatDetail) return chatDetail.participants.map((p) => ({ agentId: p.agentId, type: undefined }));
    return [];
  }, [meRow, chatDetail]);

  const primaryAgent = useMemo(
    () => pickPrimaryAgent(participantsForPrimary, myAgentId),
    [participantsForPrimary, myAgentId],
  );

  const markReadMut = useMutation({
    mutationFn: () => markMeChatRead(chatId),
    onSuccess: () => {
      // Drop the stale unread dot from every cached filter — `["me","chats"]`
      // is a prefix invalidation so any of the three filter buckets refetch.
      queryClient.invalidateQueries({ queryKey: ["me", "chats"] });
    },
  });

  // Fire mark-read whenever (chatId, lastMessageAt) is new for this mount.
  // The lastMessageAt key means: if a new message arrives while the user is
  // looking at chat B (admin WS invalidates `["me","chats"]` → meRow refreshes
  // → lastMessageAt advances), navigating back to A and on to a different
  // chat-with-new-mentions still triggers mark-read on re-entry.
  const markReadFn = markReadMut.mutate;
  const meRowLastMessageAt = meRow?.lastMessageAt ?? "";
  useEffect(() => {
    if (!meRow) return; // wait for the row to load before firing mark-read
    const seen = markedRef.current.get(chatId);
    if (seen === meRowLastMessageAt) return;
    markedRef.current.set(chatId, meRowLastMessageAt);
    markReadFn();
  }, [chatId, meRow, meRowLastMessageAt, markReadFn]);

  const joinMut = useMutation({
    mutationFn: () => joinMeChat(chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["me", "chats"] });
      queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] });
    },
  });

  const isWatching = meRow?.membershipKind === "watching";

  if (!primaryAgent) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ padding: "var(--sp-8)" }}>
        <div className="text-center" style={{ color: "var(--fg-3)" }}>
          <div className="text-subtitle" style={{ color: "var(--fg-2)", marginBottom: 6 }}>
            Loading chat…
          </div>
          <div className="text-body">Resolving participants.</div>
        </div>
      </div>
    );
  }

  if (isWatching) {
    return (
      <ChatView
        agentId={primaryAgent}
        chatId={chatId}
        readOnly
        onJoin={() => joinMut.mutate()}
        joining={joinMut.isPending}
        joinError={joinMut.isError ? (joinMut.error instanceof Error ? joinMut.error.message : "Failed to join") : null}
      />
    );
  }

  return <ChatView agentId={primaryAgent} chatId={chatId} />;
}
