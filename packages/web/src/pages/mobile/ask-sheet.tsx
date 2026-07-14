import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { getChat, listChatOpenRequests } from "../../api/chats.js";
import { useAuth } from "../../auth/auth-context.js";
import { sendAskAnswer } from "../../components/chat/ask-answer-transport.js";
import { type AskAnswer, AskTakeover } from "../../components/chat/ask-takeover.js";
import { findBlockingRequest, readRequestPayload } from "../../components/chat/request-state.js";
import type { MentionCandidate } from "../../components/mention-autocomplete.js";
import { useToast } from "../../components/ui/toast.js";
import { commitMobileAskResolution, locallyResolvedRequestIds } from "./answer-cache.js";
import { MobileSystemState } from "./components.js";

export function MobileAskSheet({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const { agentId } = useAuth();
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestsQuery = useQuery({
    queryKey: ["chat-open-requests", chatId],
    queryFn: () => listChatOpenRequests(chatId),
    refetchInterval: 5_000,
  });
  const detailQuery = useQuery({
    queryKey: ["chat-detail", chatId],
    queryFn: () => getChat(chatId),
    staleTime: 10_000,
  });

  const request = useMemo(() => {
    const locallyResolved = locallyResolvedRequestIds(queryClient, chatId);
    const ordered = [...(requestsQuery.data?.items ?? [])]
      .filter((item) => !locallyResolved.has(item.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return findBlockingRequest(ordered, agentId ?? null);
  }, [agentId, chatId, queryClient, requestsQuery.data?.items]);
  const payload = request ? readRequestPayload(request.metadata) : null;
  const askerName = request
    ? (detailQuery.data?.participants.find((participant) => participant.agentId === request.senderId)?.displayName ??
      undefined)
    : undefined;
  const mentionCandidates = useMemo<MentionCandidate[]>(
    () =>
      (detailQuery.data?.participants ?? [])
        .filter((participant) => participant.agentId !== agentId && participant.name)
        .map((participant) => ({
          agentId: participant.agentId,
          name: participant.name,
          displayName: participant.displayName,
          managedByMe: false,
          avatarImageUrl: participant.avatarImageUrl,
          avatarColorToken: participant.avatarColorToken,
        })),
    [agentId, detailQuery.data?.participants],
  );

  const submit = async (answer: AskAnswer): Promise<void> => {
    if (!request || sending) return;
    setError(null);
    setSending(true);
    try {
      await sendAskAnswer({ chatId, request, answer });
      await commitMobileAskResolution(queryClient, chatId, request.id);
      addToast({ title: "Answer sent" });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to send your answer");
      setSending(false);
    }
  };

  if (request && payload) {
    return (
      <div className="fixed inset-0" style={{ zIndex: 70 }} data-mobile-ask-sheet>
        <AskTakeover
          key={request.id}
          body={typeof request.content === "string" ? request.content : ""}
          payload={payload}
          askerName={askerName}
          sending={sending}
          error={error ?? undefined}
          mentionCandidates={mentionCandidates}
          mobile
          onDismiss={onClose}
          onReply={(answer) => {
            void submit(answer);
          }}
          onSkip={() => {
            void submit({ content: "(Skipped — no answer provided.)", mentions: [], images: [] });
          }}
        />
      </div>
    );
  }

  const loading = requestsQuery.isLoading || detailQuery.isLoading;
  const loadError = requestsQuery.error ?? detailQuery.error;
  return (
    <div
      className="fixed inset-0 flex items-end"
      style={{ zIndex: 70, background: "color-mix(in oklch, var(--fg) 10%, transparent)" }}
      data-mobile-ask-sheet
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={loading ? "Loading question" : "Question unavailable"}
        className="relative w-full"
        style={{
          minHeight: "var(--sp-35)",
          padding: "var(--sp-6) var(--sp-4) calc(var(--sp-6) + env(safe-area-inset-bottom))",
          borderTop: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-dialog) var(--radius-dialog) 0 0",
          background: "var(--bg-raised)",
          boxShadow: "var(--shadow-md)",
        }}
      >
        <button
          type="button"
          aria-label="Close question"
          onClick={onClose}
          className="absolute inline-flex items-center justify-center"
          style={{
            top: "var(--sp-2)",
            right: "var(--sp-2)",
            width: 44,
            height: 44,
            border: 0,
            borderRadius: "var(--radius-input)",
            background: "transparent",
            color: "var(--fg-3)",
          }}
        >
          <X aria-hidden className="h-5 w-5" />
        </button>
        <MobileSystemState
          title={loading ? "Loading question" : loadError ? "Couldn't load question" : "Question already handled"}
          detail={
            loading
              ? undefined
              : loadError
                ? loadError instanceof Error
                  ? loadError.message
                  : String(loadError)
                : "The feed will refresh automatically."
          }
          tone={loadError ? "error" : "idle"}
        />
      </section>
    </div>
  );
}
