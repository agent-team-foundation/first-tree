import {
  type AgentChatStatus,
  type AgentMainStatus,
  type ChatParticipantDetail,
  compareMainStatus,
  type LiveActivity,
} from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import { viewOf } from "../../lib/agent-status-view.js";
import { Button } from "../ui/button.js";
import { StatusGlyph } from "../ui/status-glyph.js";
import { formatElapsed } from "./working-chip.js";

/**
 * ComposeStatusBar — a light inline rail just above the composer that reads out
 * *what's happening in this chat right now*. Not a roster (that's the sidebar's
 * AgentStatusPanel); not the timeline's WorkingBubble (which scrolls away).
 * No box / no fill — it reads as part of the composer, with one faint hairline.
 *
 * Single line = lead + N:
 *   - lead = the highest-priority active agent (failed > needs-you > working;
 *     within working, the most-recently-active, held ~4s so working agents
 *     don't swap faces too fast — but an alert preempts immediately).
 *   - lead shows `[coloured dot] <name> · <detail>`: working → "Using Bash ·
 *     npm test · 12s" (live), needs-you → "needs reply" + [Reply], failed →
 *     "failed". The leading mark is always the state's coloured dot (no
 *     ⏸/⚠/?/!).
 *   - `+N` (others active) and a chevron expand a light multi-row list of every
 *     active agent (≤ ~5 visible, then internal scroll).
 *   - All quiet → the whole rail is hidden.
 *
 * Click zones: the lead text → jump to that agent's timeline anchor; [Reply] →
 * jump + focus the composer; +N / chevron → expand. Data is the shared
 * /agent-status query (React-Query-deduped, admin-WS-live, ~1s-throttled).
 */
const ATTENTION: ReadonlySet<string> = new Set(["needs_you", "failed", "working"]);
const TICK_INTERVAL_MS = 1000;
const LEAD_HOLD_MS = 4000;
const EXPANDED_MAX_HEIGHT = 180;

function isAlert(s: AgentChatStatus): boolean {
  return s.main === "needs_you" || s.main === "failed";
}

function activityStartedMs(s: AgentChatStatus): number {
  return s.activity ? new Date(s.activity.startedAt).getTime() : 0;
}

/**
 * The agents worth raising the bar for — needs-you / failed / working — sorted
 * highest-attention first. ready / paused / offline are filtered out. Exported
 * for tests.
 */
export function selectAttention(statuses: AgentChatStatus[]): AgentChatStatus[] {
  return statuses.filter((s) => ATTENTION.has(s.main)).sort((a, b) => compareMainStatus(a.main, b.main));
}

/**
 * Pick the rail's lead with anti-flicker, given the previously-held lead.
 * Pure & exported for tests.
 *
 * Rules: an alert (failed / needs-you) preempts immediately. Among working
 * agents the most-recently-active is the candidate, but if the current lead is
 * still working it's held until `holdMs` has elapsed (so working agents don't
 * swap faces every tick). Returns the new held lead (`{ agentId, since }`), or
 * null when nothing is active.
 */
export function pickLead(
  current: { agentId: string; since: number } | null,
  now: number,
  alerts: AgentChatStatus[],
  working: AgentChatStatus[],
  holdMs: number,
): { agentId: string; since: number } | null {
  const alert = alerts[0];
  if (alert) return { agentId: alert.agentId, since: now };
  const mostRecent = [...working].sort((a, b) => activityStartedMs(b) - activityStartedMs(a))[0];
  if (!mostRecent) return null; // nothing working
  const heldStillWorking = current !== null && working.some((w) => w.agentId === current.agentId);
  if (heldStillWorking && now - current.since < holdMs) return current; // hold the current face
  return { agentId: mostRecent.agentId, since: now };
}

/** Best-effort jump to an agent's place in the timeline (by agentId anchor). */
function scrollToAgentTimeline(agentId: string, main: AgentMainStatus, opts?: { focusComposer?: boolean }): void {
  const attr =
    main === "needs_you"
      ? "data-pending-question-agent"
      : main === "failed"
        ? "data-error-agent"
        : main === "working"
          ? "data-working-agent"
          : null;
  if (attr) {
    const els = document.querySelectorAll<HTMLElement>(`[${attr}="${agentId}"]`);
    els[els.length - 1]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  if (opts?.focusComposer) {
    document.querySelector<HTMLTextAreaElement>('[data-chat-composer="true"]')?.focus();
  }
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
  const [expanded, setExpanded] = useState(false);
  const [lead, setLead] = useState<{ agentId: string; since: number } | null>(null);
  const { data: statuses, dataUpdatedAt } = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    refetchInterval: 30_000,
  });

  // Re-pick the lead on every data update, and once more after the hold could
  // expire (so a steadily most-recent agent can take over even with no new
  // data). pickLead is pure; the timer just lets the hold lapse.
  // biome-ignore lint/correctness/useExhaustiveDependencies: statuses is keyed by dataUpdatedAt
  useEffect(() => {
    const attention = selectAttention(statuses ?? []);
    const alerts = attention.filter(isAlert);
    const working = attention.filter((s) => s.main === "working");
    const repick = () => setLead((prev) => pickLead(prev, Date.now(), alerts, working, LEAD_HOLD_MS));
    repick();
    const t = setTimeout(repick, LEAD_HOLD_MS);
    return () => clearTimeout(t);
  }, [dataUpdatedAt]);

  const attention = selectAttention(statuses ?? []);
  if (attention.length === 0) return null; // all quiet → hidden

  // Resolve the held lead to a live row; fall back to the top of `attention`
  // before the effect has settled (or if the held agent just dropped out).
  const leadRow = (lead && attention.find((s) => s.agentId === lead.agentId)) ?? attention[0];
  if (!leadRow) return null; // unreachable (attention is non-empty) — narrows the type
  const others = attention.filter((s) => s.agentId !== leadRow.agentId);

  return (
    <div
      className="fade-in flex flex-col"
      style={{
        marginBottom: "var(--sp-1)",
        paddingBottom: "var(--sp-1)",
        gap: "var(--sp-1)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div className="flex items-center" style={{ gap: "var(--sp-1_5)" }}>
        <RailRow status={leadRow} nameOf={nameFor(agents)} />
        {others.length > 0 ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse activity" : "Expand activity"}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="text-caption inline-flex shrink-0 items-center"
            style={{
              gap: "var(--sp-1)",
              border: 0,
              background: "transparent",
              padding: 0,
              cursor: "pointer",
              color: "var(--fg-4)",
            }}
          >
            +{others.length}
            <ChevronDown
              className="h-3.5 w-3.5"
              style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 150ms ease" }}
            />
          </button>
        ) : null}
      </div>

      {expanded && others.length > 0 ? (
        <div
          className="flex flex-col"
          style={{ gap: "var(--sp-1)", maxHeight: EXPANDED_MAX_HEIGHT, overflowY: "auto" }}
        >
          {attention.map((s) => (
            <RailRow key={s.agentId} status={s} nameOf={nameFor(agents)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function nameFor(agents: ChatParticipantDetail[]) {
  return (id: string) => agents.find((a) => a.agentId === id)?.displayName ?? id.slice(0, 8);
}

/** One rail line: a clickable text region (→ jump to timeline) plus, for
 *  needs-you, a [Reply] action. The two are separate targets so a jump click
 *  never lands on Reply. */
function RailRow({ status, nameOf }: { status: AgentChatStatus; nameOf: (id: string) => string }) {
  const view = viewOf(status.main);
  return (
    <div className="flex min-w-0 flex-1 items-center" style={{ gap: "var(--sp-1_5)" }}>
      <button
        type="button"
        onClick={() => scrollToAgentTimeline(status.agentId, status.main)}
        className="flex min-w-0 flex-1 items-center text-caption"
        style={{
          gap: 4,
          border: 0,
          background: "transparent",
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
          color: view.colorVar,
        }}
      >
        <StatusGlyph colorVar={view.colorVar} shape={view.shape} pulse={view.pulse} size={8} ariaLabel={view.label} />
        <span className="shrink-0">{nameOf(status.agentId)}</span>
        <Sep />
        <LeadDetail status={status} />
      </button>
      {status.main === "needs_you" ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => scrollToAgentTimeline(status.agentId, "needs_you", { focusComposer: true })}
        >
          Reply
        </Button>
      ) : null}
    </div>
  );
}

/** The detail after the name: a short reason (needs-you / failed) or the live
 *  activity (working). */
function LeadDetail({ status }: { status: AgentChatStatus }) {
  if (status.main === "needs_you") return <span className="truncate">needs reply</span>;
  if (status.main === "failed") return <span className="truncate">failed</span>;
  return <WorkingDetail activity={status.activity} />;
}

/** working detail: `Using Bash · npm test · 12s` (live ticker). */
function WorkingDetail({ activity }: { activity: LiveActivity | null }) {
  const elapsed = useLiveElapsed(activity?.startedAt ?? null);
  if (!activity) return <span className="truncate">Working</span>;
  return (
    <span className="inline-flex min-w-0 items-center" style={{ gap: 4 }}>
      <ActivityText activity={activity} />
      {elapsed ? (
        <>
          <Sep />
          <span className="mono shrink-0" style={{ color: "var(--fg-4)" }}>
            {elapsed}
          </span>
        </>
      ) : null}
    </span>
  );
}

/** "Thinking" / "Writing" (sans) or "Using <tool> · <arg>" (sans word + mono
 *  tool/arg). arg preview is already truncated server-side. */
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
