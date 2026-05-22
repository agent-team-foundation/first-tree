import { type AgentChatStatus, type ChatParticipantDetail, compareMainStatus } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pause } from "lucide-react";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import { suspendSession } from "../../api/sessions.js";
import { viewOf } from "../../lib/agent-status-view.js";
import { Avatar } from "../avatar.js";
import { StatusGlyph } from "../ui/status-glyph.js";
import { WorkingChip } from "./working-chip.js";

/**
 * AgentStatusPanel — the per-agent composite-status board, shared by the
 * chat right sidebar (always-on) and the compose status bar's expanded view
 * (step 7). One `GET /chats/:chatId/agent-status` call drives every row;
 * freshness rides the admin WS invalidation of `["chat-agent-status", id]`
 * (see use-admin-ws) — no per-agent poll.
 *
 * Each row reads its main status through the shared `viewOf` vocabulary:
 * a status-point (StatusGlyph) on the avatar + a second line that's only
 * spent on the states with detail worth surfacing (working → the live
 * activity, needs-you / failed → a short reason); ready / paused / offline
 * collapse to just the name line, distinguished by the dot's shape/colour.
 */
export function AgentStatusPanel({
  chatId,
  agents,
  canManage,
  order = "fixed",
}: {
  chatId: string;
  /** Non-human agent participants, in display order. */
  agents: ChatParticipantDetail[];
  /** Whether the caller may pause a given agent. */
  canManage: (agentId: string) => boolean;
  /** `fixed` keeps `agents` order (sidebar); `priority` sorts by attention
   *  (compose) so the most urgent agent is on top. */
  order?: "fixed" | "priority";
}) {
  const { data: statuses } = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    refetchInterval: 30_000, // safety net; the WS invalidation is the live path
  });

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
          canManage={canManage(agent.agentId)}
        />
      ))}
    </div>
  );
}

/**
 * Pause is offered only when the agent is BOTH actively producing output
 * (`main === "working"`) and on a live session (`engagement === "active"`).
 * That's the only state with a meaningful Pause — and the only transition the
 * server accepts (anything else 409s). ready / needs-you / failed / offline,
 * or a working-but-already-suspended row, get no Pause. Exported for tests.
 */
export function canPauseStatus(status: AgentChatStatus | null): boolean {
  return status?.main === "working" && status.engagement === "active";
}

function AgentStatusRow({
  chatId,
  agent,
  status,
  canManage,
}: {
  chatId: string;
  agent: ChatParticipantDetail;
  status: AgentChatStatus | null;
  canManage: boolean;
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

  const view = status ? viewOf(status.main) : null;
  const showPause = canManage && canPauseStatus(status);

  return (
    <div
      className="flex items-center transition-colors hover:bg-[var(--bg-hover)]"
      style={{ gap: "var(--sp-2_5)", padding: "var(--sp-1_75) var(--sp-2)", borderRadius: "var(--radius-input)" }}
    >
      <div className="relative shrink-0" style={{ width: 28, height: 28 }}>
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
              bottom: -2,
            }}
          >
            <StatusGlyph
              colorVar={view.colorVar}
              shape={view.shape}
              pulse={view.pulse}
              size={9}
              ariaLabel={view.label}
            />
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <div className="truncate text-subtitle">{agent.displayName}</div>
        <SecondLine status={status} />
      </div>

      {showPause ? <PauseButton onClick={() => suspendMut.mutate()} isPending={suspendMut.isPending} /> : null}
    </div>
  );
}

/**
 * The row's detail line. working → the live activity (Using <tool> · 12s) via
 * the shared WorkingChip; needs-you / failed → a short coloured reason;
 * ready / paused / offline → no second line at all (the dot's shape + colour
 * carries it, so the row collapses to a single name line).
 */
function SecondLine({ status }: { status: AgentChatStatus | null }) {
  if (!status) {
    return (
      <div className="mono text-caption" style={{ color: "var(--fg-4)" }}>
        …
      </div>
    );
  }
  if (status.main === "working" && status.activity) {
    return (
      <div className="flex items-center">
        <WorkingChip activity={status.activity} />
      </div>
    );
  }
  if (status.main === "needs_you") {
    return (
      <div className="mono text-caption" style={{ color: "var(--state-blocked)" }}>
        Waiting for your reply
      </div>
    );
  }
  if (status.main === "failed") {
    return (
      <div className="mono text-caption" style={{ color: "var(--state-error)" }}>
        Failed
      </div>
    );
  }
  // ready / paused / offline carry no detail worth a second line — the dot's
  // shape + colour already says it. Collapse to the single name row (§3.2).
  return null;
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
