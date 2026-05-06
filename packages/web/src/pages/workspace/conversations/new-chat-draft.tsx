import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getActivityOverview } from "../../../api/activity.js";
import { sendChatMessage } from "../../../api/chats.js";
import { createMeChat } from "../../../api/me-chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { useAgentNameMap } from "../../../lib/use-agent-name-map.js";
import { cn } from "../../../lib/utils.js";
import { pickDefaultTarget, type TargetCandidate, TargetPicker } from "./target-picker.js";

/**
 * Inline new-chat draft. Empty composer + TargetPicker. On send:
 *   1. POST /me/chats with the picked participants → newChatId
 *   2. POST /admin/chats/:newChatId/messages with the typed text
 *   3. Navigate to ?c=<newChatId> via the parent's `onCreated` callback
 *      (the parent updates URL state so the chat list highlights the
 *      freshly-created row and the center panel switches to ChatByIdView).
 *
 * Note: the design doc allows skipping the message body when the user just
 * wants to create the chat. We require either targets+text *or* targets
 * alone — sending an empty text just creates the chat and navigates.
 */

export function NewChatDraft({ onCreated }: { onCreated: (chatId: string) => void }) {
  const queryClient = useQueryClient();
  const { agentId: myAgentId } = useAuth();
  const agentName = useAgentNameMap();

  const [targets, setTargets] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const defaultPickedRef = useRef(false);

  const { data: activity } = useQuery({
    queryKey: ["activity"],
    queryFn: getActivityOverview,
    refetchInterval: 15_000,
  });

  const candidates = useMemo<TargetCandidate[]>(() => {
    const rows = activity?.agents ?? [];
    return rows
      .filter((a) => (myAgentId ? a.agentId !== myAgentId : true))
      .map((a) => ({
        agentId: a.agentId,
        displayName: agentName(a.agentId),
        type: a.type,
        online: !!a.clientId,
      }));
  }, [activity, agentName, myAgentId]);

  // Pre-pick the default target once candidates resolve. We keep the user
  // free to change it; the auto-pick only fires while the chip row is
  // empty so we never clobber a deliberate clear.
  useEffect(() => {
    if (defaultPickedRef.current) return;
    if (targets.length > 0) return;
    if (candidates.length === 0) return;
    const def = pickDefaultTarget(candidates, activity?.agents ?? []);
    if (def) {
      setTargets([def]);
      defaultPickedRef.current = true;
    }
  }, [candidates, activity, targets.length]);

  const createMut = useMutation({
    mutationFn: async ({ participantIds, text }: { participantIds: string[]; text: string }) => {
      const created = await createMeChat({ participantIds });
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        await sendChatMessage(created.chatId, trimmed);
      }
      return created.chatId;
    },
    onSuccess: (chatId) => {
      setDraft("");
      setTargets([]);
      defaultPickedRef.current = false;
      queryClient.invalidateQueries({ queryKey: ["me", "chats"] });
      onCreated(chatId);
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : "Failed to create chat");
    },
  });

  const canSend = targets.length > 0 && !sending && !createMut.isPending;

  const handleSend = async (): Promise<void> => {
    if (!canSend) return;
    setError(null);
    setSending(true);
    try {
      await createMut.mutateAsync({ participantIds: targets, text: draft });
    } finally {
      setSending(false);
    }
  };

  const headline =
    targets.length === 0
      ? "New chat"
      : targets.length === 1
        ? `Message ${agentName(targets[0] ?? "")}`
        : `New group chat (${targets.length} targets)`;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div
        className="shrink-0 grid items-center"
        style={{
          gridTemplateColumns: "1fr",
          gap: 8,
          padding: "var(--sp-2_5) var(--sp-3_5)",
          borderBottom: "var(--hairline) solid var(--border)",
        }}
      >
        <div>
          <div className="flex items-center" style={{ gap: 8 }}>
            <span className="text-subtitle" style={{ color: "var(--fg)" }}>
              {headline}
            </span>
            <span
              className="mono uppercase text-eyebrow"
              style={{
                padding: "var(--hairline) var(--sp-1_25)",
                borderRadius: 2,
                color: "var(--accent)",
                background: "color-mix(in oklch, var(--accent) 15%, transparent)",
              }}
            >
              draft
            </span>
          </div>
          <div className="text-caption" style={{ color: "var(--fg-3)", marginTop: 4 }}>
            Pick one or more targets, write a message, hit Send.
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" style={{ padding: "var(--sp-4) var(--sp-3_5)" }}>
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          <div
            className="flex flex-col items-center text-center"
            style={{ padding: "var(--sp-6) 0", gap: 6, color: "var(--fg-3)" }}
          >
            <p className="text-subtitle" style={{ color: "var(--fg-2)" }}>
              Hi, I'm First Tree Hub.
            </p>
            <p className="text-body">Try asking about open tasks, summaries, or what to work on next.</p>
          </div>
        </div>
      </div>

      <div
        className="shrink-0"
        style={{
          padding: "var(--sp-2_5) var(--sp-3_5)",
          borderTop: "var(--hairline) solid var(--border)",
        }}
      >
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          <div style={{ marginBottom: 8 }}>
            <TargetPicker selected={targets} onChange={setTargets} multi />
          </div>
          <div
            style={{
              position: "relative",
              border: "var(--hairline) solid var(--border)",
              borderRadius: 6,
              background: "var(--bg-sunken)",
            }}
          >
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                targets.length === 0
                  ? "Pick a target first…"
                  : targets.length === 1
                    ? `Message ${agentName(targets[0] ?? "")}`
                    : "Write a message to the group…"
              }
              rows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              disabled={createMut.isPending || sending}
              className="w-full outline-none text-subtitle font-normal"
              style={{
                padding: "var(--sp-2_25) var(--sp-3) var(--sp-7_5)",
                background: "transparent",
                border: "none",
                resize: "none",
                color: "var(--fg)",
              }}
            />
            <div
              className="flex items-center justify-between text-caption"
              style={{
                position: "absolute",
                bottom: 6,
                left: 10,
                right: 10,
                color: "var(--fg-4)",
              }}
            >
              <span className="mono">
                {targets.length === 0
                  ? "Pick at least one target."
                  : draft.trim().length === 0
                    ? "Send to create the chat without a message."
                    : null}
              </span>
              <span className="flex items-center" style={{ gap: 8 }}>
                <span>
                  <span className="kbd">⏎</span> send
                </span>
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={!canSend}
                  className={cn(
                    "inline-flex items-center transition-colors text-label font-semibold",
                    !canSend && "opacity-50 cursor-not-allowed",
                  )}
                  style={{
                    gap: 6,
                    padding: "var(--sp-1) var(--sp-2_5)",
                    color: "oklch(0.14 0.01 150)",
                    background: "var(--accent)",
                    border: "var(--hairline) solid var(--accent)",
                    borderRadius: "var(--radius-input)",
                  }}
                >
                  <Send className="h-3 w-3" /> Send
                </button>
              </span>
            </div>
          </div>
          {error && (
            <p className="mono text-label" style={{ color: "var(--state-error)", marginTop: 6 }}>
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
