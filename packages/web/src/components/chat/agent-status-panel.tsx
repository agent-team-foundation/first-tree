import { type AgentChatStatus, type ChatParticipantDetail, compareMainStatus } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pause, Play } from "lucide-react";
import { useContext } from "react";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import { resumeSession, suspendSession } from "../../api/sessions.js";
import { reconcileLiveTurn, viewOf } from "../../lib/agent-status-view.js";
import { toneOf } from "../../lib/tones.js";
import { Avatar } from "../avatar.js";
import { StatusGlyph } from "../ui/status-glyph.js";
import { AgentHovercard } from "./agent-hovercard.js";
import { LiveTurnAgentsContext } from "./live-turn-context.js";

/**
 * AgentStatusPanel — the chat right sidebar's per-agent composite-status
 * board. One `GET /chats/:chatId/agent-status` call drives every row;
 * freshness rides the admin WS invalidation of `["chat-agent-status", id]`
 * (see use-admin-ws) — no per-agent poll.
 *
 * Each row reads its main status through the shared `viewOf` vocabulary:
 * a status-point (StatusGlyph) on the avatar plus one static text label. The
 * center timeline owns activity/tool detail and error navigation; the sidebar
 * stays a calm identity + status + lightweight-control surface.
 */
export function AgentStatusPanel({
  chatId,
  agents,
  canManage,
  order = "fixed",
  compact = false,
}: {
  chatId: string;
  /** Non-human agent participants, in display order. */
  agents: ChatParticipantDetail[];
  /** Whether the caller may pause a given agent. */
  canManage: (agentId: string) => boolean;
  /** `fixed` keeps `agents` order (sidebar); `priority` sorts by attention
   *  (compose) so the most urgent agent is on top. */
  order?: "fixed" | "priority";
  /** Tighter row padding for the dense sidebar roster. The compose-bar usage
   *  keeps the roomier default. */
  compact?: boolean;
}) {
  const { data: statuses } = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    refetchInterval: 30_000, // safety net; the WS invalidation is the live path
  });
  // Agents with a live timeline turn (a mounted WorkingTurn), from ChatView via
  // context. `reconcileLiveTurn` uses it to upgrade a stale `ready` row to
  // `working` so the roster can't show Idle while the turn is visibly running.
  const liveTurnAgentIds = useContext(LiveTurnAgentsContext);
  // Per the per-chat-runtime authority refactor: working is per-chat
  // freshness stamp the server self-heals from; no local stale-clear ticker
  // needed. The admin-WS delta pushes the recomputed status down.

  const byAgent = new Map<string, AgentChatStatus>((statuses ?? []).map((s) => [s.agentId, s]));

  const ordered =
    order === "priority"
      ? [...agents].sort((a, b) => {
          const ma = byAgent.get(a.agentId)?.main ?? "offline";
          const mb = byAgent.get(b.agentId)?.main ?? "offline";
          return compareMainStatus(ma, mb);
        })
      : agents;

  return (
    <div className="flex flex-col" style={{ gap: 2 }}>
      {ordered.map((agent) => (
        <AgentStatusRow
          key={agent.agentId}
          chatId={chatId}
          agent={agent}
          status={byAgent.get(agent.agentId) ?? null}
          hasLiveTurn={liveTurnAgentIds.has(agent.agentId)}
          canManage={canManage(agent.agentId)}
          compact={compact}
        />
      ))}
    </div>
  );
}

/**
 * Pause is offered only when the agent is BOTH actively producing output
 * (`main === "working"`) and on a live session (`engagement === "active"`).
 * That's the only state with a meaningful Pause — and the only transition the
 * server accepts (anything else 409s). ready / failed / offline,
 * or a working-but-already-suspended row, get no Pause. Exported for tests.
 */
export function canPauseStatus(status: AgentChatStatus | null): boolean {
  return status?.main === "working" && status.engagement === "active";
}

export function canResumeStatus(status: AgentChatStatus | null): boolean {
  return status?.engagement === "suspended";
}

function AgentStatusRow({
  chatId,
  agent,
  status,
  hasLiveTurn,
  canManage,
  compact,
}: {
  chatId: string;
  agent: ChatParticipantDetail;
  status: AgentChatStatus | null;
  hasLiveTurn: boolean;
  canManage: boolean;
  compact: boolean;
}) {
  const queryClient = useQueryClient();
  const suspendMut = useMutation({
    mutationFn: () => suspendSession(agent.agentId, chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: chatAgentStatusQueryKey(chatId) });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
  });
  const resumeMut = useMutation({
    mutationFn: () => resumeSession(agent.agentId, chatId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: chatAgentStatusQueryKey(chatId) });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
  });

  // Reconcile a lapsed runtime heartbeat against the timeline's live-turn
  // signal: a mounted WorkingTurn upgrades `ready → working` so the row can't
  // read Idle while the conversation shows the agent working. Everything
  // downstream (glyph, second line, Pause eligibility) reads this reconciled
  // status so they stay internally consistent.
  const displayStatus = status ? reconcileLiveTurn(status, hasLiveTurn) : null;

  const view = displayStatus ? viewOf(displayStatus.main) : null;
  const showPause = canManage && canPauseStatus(displayStatus);
  const showResume = canManage && canResumeStatus(displayStatus);

  return (
    <div
      className="flex items-center transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        gap: "var(--sp-2_5)",
        padding: compact ? "var(--sp-1_25) var(--sp-2)" : "var(--sp-1_75) var(--sp-2)",
        borderRadius: "var(--radius-input)",
      }}
    >
      <AgentHovercard
        agentId={agent.agentId}
        chatId={chatId}
        name={agent.displayName}
        placement="left"
        triggerClassName="block shrink-0 cursor-pointer rounded-full"
      >
        <span className="relative block" style={{ width: 28, height: 28 }}>
          <Avatar
            src={agent.avatarImageUrl}
            name={agent.displayName}
            seed={agent.agentId}
            colorToken={agent.avatarColorToken}
            size={28}
          />
          {view ? (
            <span
              className="absolute"
              style={{
                right: -2,
                bottom: -3,
              }}
            >
              <StatusGlyph
                colorVar={view.colorVar}
                shape={view.shape}
                pulse={view.pulse}
                size={9}
                ariaLabel={view.label}
                separator
              />
            </span>
          ) : null}
        </span>
      </AgentHovercard>

      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <AgentHovercard
          agentId={agent.agentId}
          chatId={chatId}
          name={agent.displayName}
          placement="left"
          triggerClassName="block max-w-full cursor-pointer truncate text-left text-subtitle hover:underline"
        >
          {agent.displayName}
        </AgentHovercard>
        <SecondLine status={displayStatus} />
      </div>

      {showPause ? <PauseButton onClick={() => suspendMut.mutate()} isPending={suspendMut.isPending} /> : null}
      {showResume ? <ResumeButton onClick={() => resumeMut.mutate()} isPending={resumeMut.isPending} /> : null}
    </div>
  );
}

/**
 * The row's static second line — present for every state so all rows stay
 * uniform. Working/tool activity and error navigation belong to the center
 * timeline; this roster intentionally renders status only.
 */
function SecondLine({ status }: { status: AgentChatStatus | null }) {
  if (!status) {
    return (
      <div className="text-caption" style={{ color: "var(--fg-4)" }}>
        …
      </div>
    );
  }
  if (status.main === "failed") {
    return (
      <div className="flex">
        <StatePill tone="error" label="Failed" />
      </div>
    );
  }
  // working / idle / paused / offline → the state word in its own colour,
  // sans. Failed alone keeps the attention pill above.
  const view = viewOf(status.main);
  return (
    <div className="text-caption" style={{ color: view.colorVar }}>
      {view.label}
    </div>
  );
}

/**
 * A subtle tinted pill for the failed state — the state that *should* jump out.
 * Quiet states stay dot + plain coloured text.
 * sans (not mono): the status word is natural language. Geometry mirrors
 * DenseBadge; tone colours come from the shared `tones` map.
 */
function StatePill({ tone, label }: { tone: "blocked" | "error" | "idle"; label: string }) {
  const t = toneOf(tone);
  return (
    <span
      className="text-caption inline-flex items-center"
      style={{
        background: t.bg,
        color: t.fg,
        border: `var(--hairline) solid ${t.bd}`,
        padding: "var(--hairline) var(--sp-1_75)",
        borderRadius: "var(--radius-chip)",
        lineHeight: 1.6,
      }}
    >
      {label}
    </span>
  );
}

/** Compact one-click Pause (suspend). Reversible — the next message in the
 *  chat upserts the session back to active — so no confirm step. */
function PauseButton({ onClick, isPending }: { onClick: () => void; isPending: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      aria-label={isPending ? "Pausing agent" : "Pause agent"}
      title="Pause this agent in this chat"
      className="text-label inline-flex shrink-0 items-center transition-colors hover:bg-[var(--bg-warn-soft)] hover:text-[var(--fg-warn-strong)] hover:border-[var(--fg-warn-strong)]"
      style={{
        gap: "var(--sp-1)",
        padding: "var(--sp-0_5) var(--sp-2_25)",
        borderRadius: "var(--radius-input)",
        border: "var(--hairline) solid var(--border)",
        background: isPending ? "var(--bg-sunken)" : "transparent",
        color: "var(--fg-3)",
      }}
    >
      {isPending ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      ) : (
        <Pause className="h-3 w-3" aria-hidden="true" fill="currentColor" strokeWidth={0} />
      )}
      {isPending ? "Pausing" : "Pause"}
    </button>
  );
}

function ResumeButton({ onClick, isPending }: { onClick: () => void; isPending: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      aria-label={isPending ? "Resuming agent" : "Resume agent"}
      title="Resume this agent in this chat"
      className="text-label inline-flex shrink-0 items-center transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg-2)]"
      style={{
        gap: "var(--sp-1)",
        padding: "var(--sp-0_5) var(--sp-2_25)",
        borderRadius: "var(--radius-input)",
        border: "var(--hairline) solid var(--border)",
        background: isPending ? "var(--bg-sunken)" : "transparent",
        color: "var(--fg-3)",
      }}
    >
      {isPending ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      ) : (
        <Play className="h-3 w-3" aria-hidden="true" fill="currentColor" strokeWidth={0} />
      )}
      {isPending ? "Resuming" : "Resume"}
    </button>
  );
}
