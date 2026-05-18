import type { ChatParticipantDetail } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pause } from "lucide-react";
import { agentSessionsQueryKey, getSession, type SessionListItem, suspendSession } from "../../../api/sessions.js";
import { pickAvatarHue } from "../../../components/chat/chat-row-avatar.js";
import { DenseBadge } from "../../../components/ui/dense-badge.js";

/**
 * Per-agent row inside the right sidebar Agents section.
 *
 * Shows the agent's per-(agent, chat) session state and — when the
 * caller has `agent:manage` access (org admin OR the agent's manager)
 * — a Suspend button that flips an active session to `suspended`.
 *
 * Session data comes from `GET /agents/:uuid/sessions/:chatId`. A 404
 * (no row) collapses to `noSession` and renders an em-dash style row.
 */
export function AgentRow({
  participant,
  chatId,
  canSuspend,
}: {
  participant: ChatParticipantDetail;
  chatId: string;
  canSuspend: boolean;
}) {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery<SessionListItem | null>({
    queryKey: ["chat-right-sidebar", "session", participant.agentId, chatId],
    queryFn: async () => {
      try {
        return await getSession(participant.agentId, chatId);
      } catch (err) {
        // No session row yet → present the agent as idle / no-session.
        // The 404 is the normal "agent in chat but never spoke" state,
        // not an error worth surfacing on the row.
        if (err instanceof Error && err.message.toLowerCase().includes("not found")) {
          return null;
        }
        throw err;
      }
    },
    // The admin WebSocket `session:state` push invalidates `["sessions"]`
    // and `["activity"]` but NOT our new query key, so fall back to a
    // gentle poll for now. P6 (aggregate endpoint) will let us drop this.
    refetchInterval: 10_000,
  });

  const suspendMut = useMutation({
    mutationFn: () => suspendSession(participant.agentId, chatId),
    onSuccess: () => {
      // Eager refresh: refetch our own session row + every shared key the
      // admin WS push usually fans out to. The actual state-flip will be
      // confirmed by the next refetch / WebSocket frame.
      queryClient.invalidateQueries({
        queryKey: ["chat-right-sidebar", "session", participant.agentId, chatId],
      });
      queryClient.invalidateQueries({ queryKey: agentSessionsQueryKey(participant.agentId) });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
  });

  const session = sessionQuery.data;
  // While the first fetch is in flight `data` is `undefined`. Distinguish
  // "loading" from "fetched but no row" so the row doesn't briefly flash
  // "no session" before the real state lands — for a chat the user is
  // actively in, that first-render flash is misleading.
  const state = sessionQuery.isPending ? "loading" : (session?.state ?? "none");
  const view = describeState(state);
  const hue = pickAvatarHue(participant.agentId);
  const initial = (participant.displayName.trim()[0] ?? participant.name?.trim()[0] ?? "?").toUpperCase();
  // Suspend button is gated by: (a) caller permission and (b) the session
  // being in `active` — the server rejects any other transition, so
  // surfacing the button would just produce a 409 on click.
  const showSuspend = canSuspend && state === "active";
  const isSuspending = suspendMut.isPending;

  return (
    <div
      className="flex items-center transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        gap: "var(--sp-2_5)",
        padding: "var(--sp-1_75) var(--sp-2)",
        borderRadius: "var(--radius-input)",
      }}
    >
      <div className="relative shrink-0">
        <span
          aria-hidden="true"
          className="inline-flex items-center justify-center font-semibold"
          style={{
            width: 24,
            height: 24,
            borderRadius: 999,
            background: hue,
            color: "var(--fg-on-vivid)",
            fontSize: 10,
          }}
        >
          {initial}
        </span>
        {state !== "none" && state !== "loading" ? (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              right: -1,
              bottom: -1,
              width: 8,
              height: 8,
              borderRadius: 999,
              background: view.dotBg,
              border: view.dotBorder,
              boxShadow: "0 0 0 var(--hairline-bold) var(--bg-raised)",
            }}
          />
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <div className="truncate text-subtitle">{participant.displayName}</div>
        {state === "none" ? (
          <div className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            no session
          </div>
        ) : state === "loading" ? (
          <div className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            loading…
          </div>
        ) : (
          <div className="mono flex items-center text-caption" style={{ color: "var(--fg-3)" }}>
            <DenseBadge tone={view.tone}>{view.label}</DenseBadge>
          </div>
        )}
      </div>

      {showSuspend ? <SuspendButton onClick={() => suspendMut.mutate()} isPending={isSuspending} /> : null}
    </div>
  );
}

/** State view-model. Centralised so the badge tone, status-dot color,
 * and label text stay in sync — three places drifting apart is how the
 * sidebar starts lying to the user. */
function describeState(state: string): {
  label: string;
  tone: "accent" | "neutral" | "warn" | "error" | "outline";
  dotBg: string;
  dotBorder: string;
  subText: string | null;
} {
  switch (state) {
    case "active":
      return {
        label: "ACTIVE",
        tone: "accent",
        dotBg: "var(--state-idle)",
        dotBorder: "none",
        subText: "running",
      };
    case "suspended":
      return {
        label: "SUSPENDED",
        tone: "neutral",
        dotBg: "var(--bg-raised)",
        dotBorder: "var(--hairline-bold) solid var(--fg-4)",
        subText: "idle",
      };
    case "errored":
      return {
        label: "ERRORED",
        tone: "error",
        dotBg: "var(--state-error)",
        dotBorder: "none",
        subText: null,
      };
    case "evicted":
      return {
        label: "EVICTED",
        tone: "outline",
        dotBg: "var(--state-offline)",
        dotBorder: "none",
        subText: null,
      };
    case "loading":
      return {
        label: "…",
        tone: "outline",
        dotBg: "transparent",
        dotBorder: "var(--hairline-bold) solid var(--fg-4)",
        subText: null,
      };
    default:
      return {
        label: "—",
        tone: "outline",
        dotBg: "transparent",
        dotBorder: "var(--hairline-bold) solid var(--fg-4)",
        subText: "no session",
      };
  }
}

/**
 * One-click Suspend button. No confirm step: the operation is reversible
 * (the next message in the chat upserts the session back to `active`),
 * so the inline confirm we used to render added friction without buying
 * real safety. A warning-tinted Pause glyph keeps the action visually
 * distinct from neutral chips on the row.
 */
function SuspendButton({ onClick, isPending }: { onClick: () => void; isPending: boolean }) {
  if (isPending) {
    return (
      <button
        type="button"
        disabled
        aria-label="Suspending agent session"
        className="text-label inline-flex shrink-0 items-center"
        style={{
          gap: "var(--sp-1)",
          padding: "var(--sp-0_5) var(--sp-2_25)",
          borderRadius: "var(--radius-input)",
          border: "var(--hairline) solid var(--border)",
          background: "var(--bg-sunken)",
          color: "var(--fg-3)",
        }}
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Suspending
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Suspend agent session"
      className="text-label inline-flex shrink-0 items-center transition-colors hover:bg-[var(--bg-warn-soft)] hover:text-[var(--fg-warn-strong)] hover:border-[var(--fg-warn-strong)]"
      style={{
        gap: "var(--sp-1)",
        padding: "var(--sp-0_5) var(--sp-2_25)",
        borderRadius: "var(--radius-input)",
        border: "var(--hairline) solid var(--border)",
        background: "transparent",
        color: "var(--fg-3)",
      }}
      title="Suspend this agent's session in this chat"
    >
      <Pause className="h-3 w-3" aria-hidden="true" fill="currentColor" strokeWidth={0} />
      Suspend
    </button>
  );
}
