import {
  type AgentChatStatus,
  type ChatParticipantDetail,
  compareMainStatus,
  type LiveActivity,
} from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import { viewOf } from "../../lib/agent-status-view.js";
import { Button } from "../ui/button.js";
import { StatusGlyph } from "../ui/status-glyph.js";
import { formatElapsed } from "./working-chip.js";

/**
 * ComposeStatusBar — the focus-position strip just above the composer. It is
 * NOT a roster (that's the sidebar's AgentStatusPanel); it's the live read-out
 * of *what is happening in this chat right now* — persistent at the focus point
 * and, unlike the timeline's WorkingBubble, it doesn't scroll away.
 *
 * Two layers, top-down:
 *   ① Alert layer (if any) — the single most-urgent actionable state pinned on
 *      top: needs-you (+ [Reply] → scrolls to the pending question) or failed,
 *      with a "+N" when more than one agent needs attention.
 *   ② Activity layer — every working agent's detailed live activity, one row
 *      each up to 2 (`<name> · Using Bash · npm test · 12s`, live ticker); a
 *      "+N working" expands to list the rest.
 * All quiet (no alert, no working) → the whole strip is hidden.
 *
 * Data is the same chat-level /agent-status query the sidebar/header use
 * (React-Query-deduped, admin-WS-live, ~1s-throttled so it can't strobe).
 */
const ATTENTION: ReadonlySet<string> = new Set(["needs_you", "failed", "working"]);
const TICK_INTERVAL_MS = 1000;
const MAX_ACTIVITY_ROWS = 2;

/**
 * The agents worth raising the bar for — needs-you / failed / working — sorted
 * highest-attention first. ready / paused / offline are filtered out. Exported
 * for tests.
 */
export function selectAttention(statuses: AgentChatStatus[]): AgentChatStatus[] {
  return statuses.filter((s) => ATTENTION.has(s.main)).sort((a, b) => compareMainStatus(a.main, b.main));
}

function scrollToPendingQuestion(): void {
  const els = document.querySelectorAll<HTMLElement>('[data-pending-question="true"]');
  els[els.length - 1]?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/** Live wall-clock elapsed since `startedAt`, re-rendering each second. */
function useLiveElapsed(startedAt: string | null): string | null {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  return formatElapsed(now - new Date(startedAt).getTime());
}

export function ComposeStatusBar({
  chatId,
  agents,
}: {
  chatId: string;
  /** Non-human agent participants (for name lookup). */
  agents: ChatParticipantDetail[];
}) {
  const [showAllWorking, setShowAllWorking] = useState(false);
  const { data: statuses } = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    refetchInterval: 30_000,
  });

  const nameOf = (id: string) => agents.find((a) => a.agentId === id)?.displayName ?? id.slice(0, 8);

  const attention = selectAttention(statuses ?? []);
  const alerts = attention.filter((s) => s.main === "needs_you" || s.main === "failed");
  const working = attention.filter((s) => s.main === "working");
  if (alerts.length === 0 && working.length === 0) return null; // all quiet → hidden

  const topAlert = alerts[0];
  const visibleWorking = showAllWorking ? working : working.slice(0, MAX_ACTIVITY_ROWS);
  const hiddenWorking = working.length - visibleWorking.length;

  return (
    <div
      className="fade-in flex flex-col"
      style={{
        marginBottom: "var(--sp-1_5)",
        gap: "var(--sp-1)",
        padding: "var(--sp-1_5) var(--sp-2_5)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        background: "var(--bg-sunken)",
      }}
    >
      {topAlert ? <AlertRow status={topAlert} nameOf={nameOf} extra={alerts.length - 1} /> : null}
      {visibleWorking.map((s) => (
        <ActivityRow key={s.agentId} status={s} nameOf={nameOf} />
      ))}
      {working.length > MAX_ACTIVITY_ROWS ? (
        <button
          type="button"
          onClick={() => setShowAllWorking((v) => !v)}
          className="text-caption inline-flex items-center self-start"
          style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", color: "var(--fg-4)" }}
        >
          {showAllWorking ? "Show less" : `+${hiddenWorking} working`}
        </button>
      ) : null}
    </div>
  );
}

/** ① The most-urgent actionable state, pinned on top. needs-you carries the
 *  [Reply] jump; a "+N" trails when more than one agent needs attention. */
function AlertRow({
  status,
  nameOf,
  extra,
}: {
  status: AgentChatStatus;
  nameOf: (id: string) => string;
  extra: number;
}) {
  const view = viewOf(status.main);
  const isNeedsYou = status.main === "needs_you";
  return (
    <div className="flex items-center" style={{ gap: "var(--sp-1_5)", color: view.colorVar }}>
      <StatusGlyph colorVar={view.colorVar} shape={view.shape} pulse={view.pulse} size={8} ariaLabel={view.label} />
      <span className="text-caption truncate">
        {nameOf(status.agentId)} {isNeedsYou ? "needs your reply" : "failed"}
      </span>
      <div className="flex shrink-0 items-center" style={{ gap: "var(--sp-1_5)", marginLeft: "auto" }}>
        {extra > 0 ? (
          <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
            +{extra}
          </span>
        ) : null}
        {isNeedsYou ? (
          <Button type="button" variant="secondary" size="sm" onClick={scrollToPendingQuestion}>
            Reply
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** ② One working agent's detailed live activity: `[•] <name> · <action> · <timer>`.
 *  The status word is sans; the tool / arg / timer are mono. */
function ActivityRow({ status, nameOf }: { status: AgentChatStatus; nameOf: (id: string) => string }) {
  const activity = status.activity;
  const elapsed = useLiveElapsed(activity?.startedAt ?? null);
  return (
    <div className="flex min-w-0 items-center text-caption" style={{ gap: 4, color: "var(--state-working)" }}>
      <StatusGlyph colorVar="var(--state-working)" shape="dot" pulse="working" size={8} ariaLabel="Working" />
      <span className="shrink-0">{nameOf(status.agentId)}</span>
      <Sep />
      {activity ? <ActivityText activity={activity} /> : <span>Working</span>}
      {activity && elapsed ? (
        <>
          <Sep />
          <span className="mono shrink-0" style={{ color: "var(--fg-4)" }}>
            {elapsed}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** The action segment: "Thinking" / "Writing" (sans) or "Using <tool> · <arg>"
 *  (sans word + mono tool/arg). arg preview is already truncated server-side. */
function ActivityText({ activity }: { activity: LiveActivity }) {
  if (activity.kind === "thinking") return <span className="truncate">Thinking</span>;
  if (activity.kind === "assistant_text") return <span className="truncate">Writing</span>;
  return (
    <span className="inline-flex min-w-0 items-center" style={{ gap: 4 }}>
      <span className="shrink-0">Using</span>
      <span className="mono shrink-0">{activity.label}</span>
      {activity.detail ? (
        <>
          <Sep />
          <span className="mono truncate" style={{ color: "var(--fg-4)" }}>
            {activity.detail}
          </span>
        </>
      ) : null}
    </span>
  );
}

/** Muted "·" segment separator. */
function Sep() {
  return (
    <span aria-hidden="true" className="shrink-0" style={{ color: "var(--fg-4)" }}>
      ·
    </span>
  );
}
