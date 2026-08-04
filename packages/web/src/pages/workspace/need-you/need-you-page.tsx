import { imageAttachmentRefsFromMetadata, type NeedYouRequestItem, type RequestResolution } from "@first-tree/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, ExternalLink, History, LoaderCircle } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { getChat } from "../../../api/chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { sendAskAnswer } from "../../../components/chat/ask-answer-transport.js";
import { type AskAnswer, AskTakeover, clearAskTakeoverDraft } from "../../../components/chat/ask-takeover.js";
import { readRequestPayload } from "../../../components/chat/request-state.js";
import { useAskAgent } from "../../../components/chat/use-ask-agent.js";
import type { MentionCandidate } from "../../../components/mention-autocomplete.js";
import { Markdown } from "../../../components/ui/markdown.js";
import { useGitlabEntityPresentation } from "../../../hooks/use-gitlab-entity-presentation.js";
import { needYouQueryOptions, removeResolvedNeedYouRequest } from "./query.js";

export function NeedYouPage({
  mobile = false,
  onClose,
  onOpenFullChat,
}: {
  mobile?: boolean;
  onClose: () => void;
  /** Open the request's chat. With `focus` the chat opens narrowed to the
   *  viewer's conversation with that agent — the "Show earlier chat" path.
   *  `requestId` lets the chat report honestly when the reviewed question is
   *  older than its loaded history. The narrowing is a transient URL-carried
   *  view, not a stored preference: re-opening the chat later shows all
   *  messages. */
  onOpenFullChat: (chatId: string, focus?: { agentId: string; requestId: string }) => void;
}) {
  const queryClient = useQueryClient();
  const { organizationId, agentId: humanAgentId } = useAuth();
  const queue = useQuery(needYouQueryOptions(organizationId));
  const item = queue.data?.items[0] ?? null;
  const [sendingRequestId, setSendingRequestId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const requestId = item?.request.id ?? null;

  useEffect(() => {
    // The selected request intentionally keys all transient review state.
    void requestId;
    setSendingRequestId(null);
    setSendError(null);
  }, [requestId]);

  const chatDetail = useQuery({
    queryKey: ["chat-detail", item?.chat.id],
    queryFn: () => {
      if (!item) throw new Error("No request selected");
      return getChat(item.chat.id);
    },
    enabled: item !== null,
    staleTime: 10_000,
  });

  const mentionCandidates = useMemo<MentionCandidate[]>(
    () =>
      (chatDetail.data?.participants ?? []).flatMap((participant) => {
        if (participant.agentId === humanAgentId || !participant.name) return [];
        return [
          {
            agentId: participant.agentId,
            name: participant.name,
            displayName: participant.displayName,
            managedByMe: false,
            avatarColorToken: participant.avatarColorToken,
            avatarImageUrl: participant.avatarImageUrl,
          },
        ];
      }),
    [chatDetail.data?.participants, humanAgentId],
  );

  const askAgent = useAskAgent({
    chatId: item?.chat.id ?? "",
    requestId,
    humanAgentId,
    askerAgentId: item?.asker.agentId ?? null,
  });
  const reviewLocked = (requestId !== null && sendingRequestId === requestId) || askAgent.sending || askAgent.waiting;
  const closeReview = useCallback(() => {
    if (!reviewLocked) onClose();
  }, [onClose, reviewLocked]);
  const showEarlierChat = useCallback(() => {
    if (!reviewLocked && item) {
      onOpenFullChat(item.chat.id, { agentId: item.asker.agentId, requestId: item.request.id });
    }
  }, [reviewLocked, item, onOpenFullChat]);
  const { markdownComponents } = useGitlabEntityPresentation(organizationId);

  const resolveRequest = async (
    answer: AskAnswer,
    resolutionKind: RequestResolution["kind"] = "answered",
  ): Promise<void> => {
    if (!item || sendingRequestId === item.request.id) return;
    const resolvingId = item.request.id;
    setSendError(null);
    setSendingRequestId(resolvingId);
    try {
      await sendAskAnswer({
        chatId: item.chat.id,
        request: item.request,
        answer,
        resolutionKind,
      });
      clearAskTakeoverDraft(resolvingId);
      removeResolvedNeedYouRequest(queryClient, organizationId, resolvingId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["need-you"] }),
        queryClient.invalidateQueries({ queryKey: ["chat-open-requests", item.chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["chat-messages", item.chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["request-thread", item.chat.id, resolvingId] }),
        queryClient.invalidateQueries({ queryKey: ["me", "chats"] }),
      ]);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "Failed to submit your answer");
      setSendingRequestId(null);
    }
  };

  return (
    <section
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      style={{ background: "var(--bg)" }}
      aria-label="Need you"
    >
      <header
        className="flex h-[var(--sp-12)] shrink-0 items-center"
        style={{
          gap: "var(--sp-2)",
          padding: mobile ? "0 var(--sp-3)" : "0 var(--sp-5)",
          borderBottom: "var(--hairline) solid var(--border)",
          background: "var(--bg-raised)",
        }}
      >
        <button
          type="button"
          onClick={closeReview}
          disabled={reviewLocked}
          aria-label="Back to Chat"
          className="inline-flex h-11 w-11 items-center justify-center"
          style={{
            border: 0,
            borderRadius: "var(--radius-input)",
            background: "transparent",
            color: "var(--fg-2)",
            cursor: reviewLocked ? "default" : "pointer",
            opacity: reviewLocked ? 0.5 : 1,
          }}
        >
          <ArrowLeft aria-hidden className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className={mobile ? "text-mobile-subtitle" : "text-subtitle"} style={{ margin: 0, color: "var(--fg)" }}>
            Need you
          </h1>
          {item ? (
            <p className="text-caption truncate" style={{ margin: 0, color: "var(--fg-4)" }}>
              {item.chat.title} · {queue.data?.total ?? 0} waiting
            </p>
          ) : null}
        </div>
        {item ? (
          <button
            type="button"
            onClick={() => {
              if (!reviewLocked) onOpenFullChat(item.chat.id);
            }}
            disabled={reviewLocked}
            className="text-label inline-flex items-center"
            style={{
              gap: "var(--sp-1)",
              minHeight: mobile ? 44 : 34,
              padding: "0 var(--sp-3)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-input)",
              background: "var(--bg-raised)",
              color: "var(--fg-2)",
              cursor: reviewLocked ? "default" : "pointer",
              opacity: reviewLocked ? 0.5 : 1,
            }}
          >
            <span>{mobile ? "Full chat" : "Open full chat"}</span>
            <ExternalLink aria-hidden className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </header>

      <div className="relative min-h-0 flex-1">
        {queue.isLoading ? (
          <CenteredState icon={<LoaderCircle className="h-8 w-8 animate-spin" />} title="Loading questions…" />
        ) : queue.isError ? (
          <CenteredState
            title="Couldn’t load Need you"
            detail={queue.error instanceof Error ? queue.error.message : "Try again."}
            action={
              <button type="button" onClick={() => void queue.refetch()}>
                Retry
              </button>
            }
          />
        ) : !item && (queue.data?.total ?? 0) > 0 ? (
          <CenteredState icon={<LoaderCircle className="h-8 w-8 animate-spin" />} title="Loading the next question…" />
        ) : !item ? (
          <CenteredState
            icon={<CheckCircle2 className="h-10 w-10" />}
            title="You’re all caught up"
            detail="New questions will appear here."
          />
        ) : (
          <AskTakeover
            key={item.request.id}
            requestId={item.request.id}
            body={
              typeof item.request.content === "string" ? item.request.content : JSON.stringify(item.request.content)
            }
            images={imageAttachmentRefsFromMetadata(item.request.metadata).map((ref) => ({
              imageId: ref.attachmentId,
              filename: ref.filename,
            }))}
            payload={readRequestPayload(item.request.metadata)}
            askerName={item.asker.displayName}
            sending={sendingRequestId === item.request.id}
            error={sendError ?? undefined}
            mentionCandidates={mentionCandidates}
            markdownComponents={markdownComponents}
            mobile={mobile}
            contextBefore={<ChatContextHeader item={item} locked={reviewLocked} onShowEarlierChat={showEarlierChat} />}
            onRequestEarlierContext={showEarlierChat}
            onEscape={closeReview}
            askAgent={{
              exchanges: askAgent.exchanges,
              waiting: askAgent.waiting,
              sending: askAgent.sending,
              error: askAgent.error,
              onAsk: askAgent.ask,
            }}
            onReply={(answer) => {
              void resolveRequest(answer);
            }}
            onSkip={() => {
              void resolveRequest(
                {
                  content: "(Skipped — no answer provided.)",
                  mentions: [],
                  images: [],
                },
                "closed",
              );
            }}
          />
        )}
      </div>
    </section>
  );
}

/**
 * Chat context above the question: the chat's running description, plus the
 * jump to the earlier conversation. The earlier chat is no longer previewed
 * inline — the button opens the full chat narrowed (transiently) to the
 * viewer's conversation with the asker, where the real timeline, scrollback,
 * and "Show all messages" all already exist.
 */
function ChatContextHeader({
  item,
  locked,
  onShowEarlierChat,
}: {
  item: NeedYouRequestItem;
  locked: boolean;
  onShowEarlierChat: () => void;
}) {
  return (
    <div style={{ padding: "var(--sp-4) var(--sp-5)", background: "var(--bg-sunken)" }}>
      {item.chat.description ? (
        <div style={{ marginBottom: "var(--sp-3)" }}>
          <div className="text-eyebrow" style={{ color: "var(--fg-4)", marginBottom: "var(--sp-1)" }}>
            Current chat
          </div>
          <Markdown>{item.chat.description}</Markdown>
        </div>
      ) : null}
      <button
        type="button"
        onClick={onShowEarlierChat}
        disabled={locked}
        className="text-label inline-flex items-center"
        style={{
          gap: "var(--sp-1_5)",
          padding: 0,
          border: 0,
          background: "transparent",
          color: "var(--fg-2)",
          cursor: locked ? "default" : "pointer",
          opacity: locked ? 0.5 : 1,
        }}
      >
        <History aria-hidden className="h-4 w-4" />
        Show earlier chat
      </button>
    </div>
  );
}

function CenteredState({
  icon,
  title,
  detail,
  action,
}: {
  icon?: ReactNode;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center text-center"
      style={{ gap: "var(--sp-2)", padding: "var(--sp-8)", color: "var(--fg-3)" }}
    >
      <div style={{ color: "var(--fg-4)" }}>{icon}</div>
      <h2 className="text-subtitle" style={{ margin: 0, color: "var(--fg-2)" }}>
        {title}
      </h2>
      {detail ? (
        <p className="text-body" style={{ margin: 0 }}>
          {detail}
        </p>
      ) : null}
      {action}
    </div>
  );
}
