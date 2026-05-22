import { type AgentChatStatus, type ChatParticipantDetail, compareMainStatus } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pause } from "lucide-react";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import { suspendSession } from "../../api/sessions.js";
import { viewOf } from "../../lib/agent-status-view.js";
import { toneOf } from "../../lib/tones.js";
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
 * a status-point (StatusGlyph) on the avatar + a second line for every state
 * (working → the live activity, needs-you / failed → a tinted attention pill,
 * idle / paused / offline → the state word in its own colour), so all rows
 * stay uniform / equal-height. The dot carries the shape + colour distinction.
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
 * The row's second line — present for every state so all rows stay uniform.
 * Status words are sans (natural language); only technical info (tool name,
 * timer) is mono. The two *attention* states get a subtle tinted pill so they
 * jump out; the quiet states stay dot + plain coloured text:
 *   working            → "Working" (sans, blue) · "Bash · 0s" (mono, live)
 *   needs-you          → "Needs reply" pill (amber)
 *   failed             → "Failed" pill (red)
 *   idle/paused/offline → the state word in its own colour (sans)
 */
function SecondLine({ status }: { status: AgentChatStatus | null }) {
  if (!status) {
    return (
      <div className="text-caption" style={{ color: "var(--fg-4)" }}>
        …
      </div>
    );
  }
  if (status.main === "working" && status.activity) {
    // "Working" (sans word) · "Bash · 0s" (mono tool + live timer). No leading
    // pulse dot — the avatar already carries the breathing status dot.
    return (
      <div className="flex items-center text-caption" style={{ gap: 4, color: "var(--state-working)" }}>
        <span>Working</span>
        <span aria-hidden="true">·</span>
        <WorkingChip activity={status.activity} showDot={false} monochrome />
      </div>
    );
  }
  if (status.main === "needs_you") {
    return (
      <div className="flex">
        <StatePill tone="blocked" label="Needs reply" />
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
  // idle / paused / offline → the state word in its own colour, sans. No pill:
  // these are the quiet, lowest-attention states — a tinted pill would
  // over-weight them. The dot still carries the shape + colour.
  const view = viewOf(status.main);
  return (
    <div className="text-caption" style={{ color: view.colorVar }}>
      {view.label}
    </div>
  );
}

/**
 * A subtle tinted pill for the attention states (needs-you / failed) — the
 * states that *should* jump out. Quiet states stay dot + plain coloured text.
 * sans (not mono): the status word is natural language. Geometry mirrors
 * DenseBadge; tone colours come from the shared `tones` map.
 */
function StatePill({ tone, label }: { tone: "blocked" | "error"; label: string }) {
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
