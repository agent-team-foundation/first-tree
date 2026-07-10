import type { ListMeChatsResponse } from "@first-tree/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { getChat } from "../../../api/chats.js";
import { joinMeChat, markMeChatRead } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { Button } from "../../../components/ui/button.js";
import { useAdminWs } from "../../../hooks/use-admin-ws.js";
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
 * Reads everything off `chatDetail` — speaker/watcher distinction comes
 * from `chatDetail.viewerMembershipKind`, participant `type` comes from
 * the wire schema. The earlier implementation also pulled two filter
 * variants of `/orgs/:orgId/chats` just to find this one row, which
 * compounded every `["me","chats"]` invalidate into 3 concurrent
 * list fetches.
 *
 * Mark-read fires on mount and on every incoming `chat:message` frame
 * for this chatId (the server-side write is a single idempotent UPSERT,
 * so re-firing is cheap and lets the conversation-list's unread badge
 * drop without the user having to leave + return).
 */

function pickPrimaryAgent(participants: { agentId: string; type: string }[], myAgentId: string | null): string | null {
  const nonSelf = participants.filter((p) => p.agentId !== myAgentId);
  const nonHuman = nonSelf.find((p) => p.type !== "human");
  if (nonHuman) return nonHuman.agentId;
  return nonSelf[0]?.agentId ?? null;
}

function patchReadChatInCachedLists(queryClient: QueryClient, chatId: string, unreadMentionCount: number): void {
  const cachedQueries = queryClient.getQueryCache().findAll({ queryKey: ["me", "chats"] });
  for (const query of cachedQueries) {
    const unreadFilter = query.queryKey[2] === "unread";
    queryClient.setQueryData<ListMeChatsResponse>(query.queryKey, (prev) => {
      if (!prev) return prev;
      let changed = false;
      const rows = prev.rows.flatMap((row) => {
        if (row.chatId !== chatId) return [row];
        changed = true;
        const patched = {
          ...row,
          unreadMentionCount,
          chatHasExplicitMentionToMe: false,
        };
        return unreadFilter && unreadMentionCount <= 0 ? [] : [patched];
      });
      return changed ? { ...prev, rows } : prev;
    });
  }
}

export function ChatByIdView({
  chatId,
  narrow,
  onShowConversations,
  onClearChat = null,
  presentation = "workspace",
  isTrial = false,
}: {
  chatId: string;
  narrow: boolean;
  onShowConversations: (() => void) | null;
  onClearChat?: (() => void) | null;
  presentation?: "workspace" | "mobile";
  /** Trial surface: forwarded to ChatView to hide chat-management escape
   *  hatches (add participant, agent pause/resume). */
  isTrial?: boolean;
}) {
  const queryClient = useQueryClient();
  const { agentId: myAgentId, organizationId: currentOrgId, selectOrganization, memberships, switchingOrg } = useAuth();

  const { data: chatDetail, isError: chatDetailError } = useQuery({
    queryKey: ["chat-detail", chatId],
    queryFn: () => getChat(chatId),
    enabled: !!chatId,
  });

  // Cross-org chat links: a chat is routed by a global `?c=<chatId>` with no
  // org segment, and the per-chat reads (`getChat` / messages) resolve by UUID
  // regardless of the selected org. So opening a chat that lives in a *different*
  // org than the one currently selected would render that org's conversation in
  // the center while the rest of the shell (conversation rail, team name, agent
  // roster, admin WebSocket) stayed on the old org. Switch the whole workspace
  // to the chat's org so the shell follows the conversation.
  //
  // Only switch into an org the user actually belongs to. The server already
  // guarantees this (`requireChatAccess` 404s a chat outside the caller's orgs
  // before its detail can load), but the guard keeps a stale `/me` from looping:
  // `currentOrgId` is derived from `memberships`, so a switch into an org absent
  // from that list would never settle and the effect would re-fire. The
  // per-target ref additionally suppresses a re-fire while the switch + `/me`
  // refetch is in flight.
  const switchedOrgRef = useRef<string | null>(null);
  useEffect(() => {
    const chatOrg = chatDetail?.organizationId;
    if (switchingOrg) return;
    if (!chatOrg || !currentOrgId || chatOrg === currentOrgId) return;
    if (switchedOrgRef.current === chatOrg) return;
    if (!memberships.some((m) => m.organizationId === chatOrg)) return;
    switchedOrgRef.current = chatOrg;
    void selectOrganization(chatOrg);
  }, [chatDetail?.organizationId, currentOrgId, memberships, selectOrganization, switchingOrg]);

  const primaryAgent = useMemo(() => {
    if (!chatDetail) return null;
    return pickPrimaryAgent(
      chatDetail.participants.map((p) => ({ agentId: p.agentId, type: p.type })),
      myAgentId,
    );
  }, [chatDetail, myAgentId]);

  const markReadMut = useMutation({
    mutationFn: () => markMeChatRead(chatId),
    onSuccess: (res) => {
      const readChatId = typeof res.chatId === "string" ? res.chatId : chatId;
      const unreadMentionCount = typeof res.unreadMentionCount === "number" ? res.unreadMentionCount : 0;
      patchReadChatInCachedLists(queryClient, readChatId, unreadMentionCount);
    },
  });

  // Track whether we've already fired mark-read for the current chatId so a
  // strict-mode double-mount or a `chatDetail` refetch doesn't pile up redundant
  // POSTs. Incoming `chat:message` and `ws:reconnect` frames still re-fire below.
  const markReadFn = markReadMut.mutate;
  const markedChatIdRef = useRef<string | null>(null);
  // Whether the caller has a chat_membership row (speaker or watcher).
  // Supervisor / admin views reach this page via managed agents and have
  // no row of their own — firing markRead would `INSERT INTO chat_user_state`
  // a row the conversation-list query (INNER JOIN `chat_membership`) never
  // reads, leaving permanent dead rows in the table. Wait for chatDetail to
  // load before deciding; once known, all three trigger points (mount,
  // chat:message, ws:reconnect) share the same gate.
  const canMarkRead = chatDetail != null && chatDetail.viewerMembershipKind !== null;
  useEffect(() => {
    if (!canMarkRead) return;
    if (markedChatIdRef.current === chatId) return;
    markedChatIdRef.current = chatId;
    markReadFn();
  }, [chatId, canMarkRead, markReadFn]);

  // Re-fire on every incoming message for this chat — the user has the
  // composer open and is reading in real time, so the unread state on the
  // list rail should follow. `ws:reconnect` is a synthetic frame emitted
  // by `use-admin-ws` after a WS gap closes, covering the case where
  // chat:message frames fired while the socket was down (the chat-detail
  // and chat-messages caches catch up via the reconnect-block invalidate,
  // but the unread badge needs an explicit markRead because nothing else
  // observes "we are looking at this chat right now").
  useAdminWs({
    onMessage: (msg) => {
      if (!canMarkRead) return;
      if (msg.type === "ws:reconnect") {
        markReadFn();
        return;
      }
      if (msg.type !== "chat:message") return;
      const incomingChatId = typeof msg.chatId === "string" ? msg.chatId : null;
      if (incomingChatId !== chatId) return;
      markReadFn();
    },
  });

  const joinMut = useMutation({
    mutationFn: () => joinMeChat(chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["me", "chats"] });
      queryClient.invalidateQueries({ queryKey: ["chat-detail", chatId] });
    },
  });

  const isWatching = chatDetail?.viewerMembershipKind === "watching";

  if (chatDetailError) {
    return <ChatUnavailableState onClearChat={onClearChat} />;
  }

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
        initialChatDetail={chatDetail}
        readOnly
        // Forward `isTrial` on the watcher branch too: the trial-chrome
        // guarantee is route-scoped, so `/quickstart?c=<any>` must stay a pure
        // conversation even if the viewer resolves as a watcher (readOnly
        // hides some surfaces, but not the per-message hovercard).
        isTrial={isTrial}
        titleFallback={chatDetail?.title ?? null}
        presentation={presentation}
        joinAction={{
          onJoin: () => joinMut.mutate(),
          joining: joinMut.isPending,
          error: joinMut.isError ? (joinMut.error instanceof Error ? joinMut.error.message : "Failed to join") : null,
        }}
        narrow={narrow}
        onShowConversations={onShowConversations}
      />
    );
  }

  return (
    <ChatView
      agentId={primaryAgent}
      chatId={chatId}
      initialChatDetail={chatDetail}
      narrow={narrow}
      onShowConversations={onShowConversations}
      presentation={presentation}
      isTrial={isTrial}
    />
  );
}

function ChatUnavailableState({ onClearChat }: { onClearChat: (() => void) | null }) {
  return (
    <div className="flex-1 flex items-center justify-center" style={{ padding: "var(--sp-8)" }}>
      <div className="text-center max-w-sm">
        <div className="text-subtitle" style={{ color: "var(--fg-2)", marginBottom: 6 }}>
          Chat unavailable
        </div>
        <div className="text-body text-muted-foreground" style={{ marginBottom: "var(--sp-4)" }}>
          This chat doesn't exist or you don't have access.
        </div>
        {onClearChat ? (
          <div className="flex justify-center">
            <Button type="button" variant="outline" onClick={onClearChat}>
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>Back to conversations</span>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
