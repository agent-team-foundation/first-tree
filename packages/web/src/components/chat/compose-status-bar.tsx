import {
  type AgentChatStatus,
  type ChatParticipantDetail,
  compareMainStatus,
  type LiveActivity,
} from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { Brain, ChevronDown, ChevronsUpDown, Pencil, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import { viewOf } from "../../lib/agent-status-view.js";
import { stripInlineMarkdown } from "../../lib/strip-inline-markdown.js";
import { isJumpable, useMountedAnchors } from "../../lib/use-mounted-anchors.js";
import { StatusGlyph } from "../ui/status-glyph.js";
import { TimelineJumpButton } from "./timeline-jump-button.js";
import { formatElapsed } from "./working-chip.js";

/**
 * ComposeStatusBar — a light inline rail just above the composer that reads out
 * *what's happening in this chat right now*. Not a roster (that's the sidebar's
 * AgentStatusPanel); not the timeline's WorkingTurn (which scrolls away).
 * No box / no fill — it reads as part of the composer, with one faint hairline.
 *
 * Scope: only **working** and **failed** raise the bar.
 *
 * Single line = lead + N:
 *   - lead = the highest-priority active agent (failed > working; within
 *     working, the most-recently-active, held ~4s so working agents don't swap
 *     faces too fast — but a failure preempts immediately).
 *   - lead shows `[coloured dot] <name> · <goal> · <tool> · 12s`: working puts
 *     the agent's running narration (`turnText`, the *goal* — what it's trying
 *     to do) first, then the live action (the *means* — `Bash · npm test`,
 *     `Thinking`, …) with a kind icon, then the elapsed ticker; failed → "failed".
 *   - `+N` (others active) and a chevron expand a light multi-row list of every
 *     active agent (≤ ~5 visible, then internal scroll).
 *   - All quiet → the whole rail is hidden.
 *
 * Click zones: the lead/row text → jump to that agent's timeline anchor
 * (working → WorkingTurn, failed → ErrorRow); +N / chevron → expand. Data is
 * the shared /agent-status query (React-Query-deduped, admin-WS-live,
 * ~1s-throttled).
 */
const ATTENTION: ReadonlySet<string> = new Set(["failed", "working"]);
const TICK_INTERVAL_MS = 1000;
const LEAD_HOLD_MS = 4000;
const EXPANDED_MAX_HEIGHT = 180;

/** A failure preempts the working-lead anti-flicker hold (see {@link pickLead}).
 *  "alert" is just "failed". */
function isAlert(s: AgentChatStatus): boolean {
  return s.main === "failed" || isFatalStatusReason(s);
}

function activityStartedMs(s: AgentChatStatus): number {
  return s.activity ? new Date(s.activity.startedAt).getTime() : 0;
}

/**
 * The agents worth raising the bar for — failed / working — sorted
 * highest-attention first. ready / paused / offline are filtered out.
 * Exported for tests.
 */
export function selectAttention(statuses: AgentChatStatus[]): AgentChatStatus[] {
  return statuses
    .filter((s) => ATTENTION.has(s.main) || s.statusReason !== undefined)
    .sort((a, b) => attentionRank(a) - attentionRank(b) || compareMainStatus(a.main, b.main));
}

function attentionRank(status: AgentChatStatus): number {
  if (status.main === "failed" || isFatalStatusReason(status)) return 0;
  if (status.main === "working") return 1;
  if (status.statusReason?.kind === "terminal") return 2;
  if (status.statusReason?.kind === "waiting") return 3;
  if (status.statusReason?.kind === "retrying") return 4;
  return 5;
}

function isFatalStatusReason(status: AgentChatStatus): boolean {
  return status.statusReason?.kind === "terminal" && status.statusReason.severity === "error";
}

/**
 * Pick the rail's lead with anti-flicker, given the previously-held lead.
 * Pure & exported for tests.
 *
 * Rules: an alert (failed) preempts immediately. Among working agents the
 * most-recently-active is the candidate, but if the current lead is still
 * working it's held until `holdMs` has elapsed (so working agents don't swap
 * faces every tick). Returns the new held lead (`{ agentId, since }`), or null
 * when nothing is active.
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
  // Which agent's full-narration card is open (its agentId), or null. Keyed by
  // agent — not a bare boolean — so the card auto-hides when the lead switches
  // (no reset effect), and its trigger chevron (outside the card) is excluded
  // from the outside-press close.
  const [cardOpenFor, setCardOpenFor] = useState<string | null>(null);
  const cardTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Stable so TurnTextCard's document-listener effect doesn't re-subscribe on
  // every parent re-render (query refetch / elapsed tick).
  const closeCard = useCallback(() => setCardOpenFor(null), []);
  const [lead, setLead] = useState<{ agentId: string; since: number } | null>(null);
  const { data: statuses } = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    refetchInterval: 30_000,
  });
  const mounted = useMountedAnchors();

  // Per the per-chat-runtime authority refactor: working is now per-chat
  // (runtime_state + freshness stamp) and pushed via admin-WS delta, so the
  // local stale-clear ticker that used to live here is gone — the server
  // self-heals after RUNTIME_STALE_MS and pushes the delta down.
  // Re-pick the lead whenever the status set changes, and once more after
  // the hold could expire so a steadily most-recent agent can take over
  // even with no new data. pickLead is pure; the timer just lets the hold
  // lapse.
  useEffect(() => {
    const attention = selectAttention(statuses ?? []);
    const alerts = attention.filter(isAlert);
    const working = attention.filter((s) => s.main === "working");
    const repick = () => setLead((prev) => pickLead(prev, Date.now(), alerts, working, LEAD_HOLD_MS));
    repick();
    const t = setTimeout(repick, LEAD_HOLD_MS);
    return () => clearTimeout(t);
  }, [statuses]);

  const attention = selectAttention(statuses ?? []);
  // Resolve the held lead to a live row; fall back to the top of `attention`
  // before the effect has settled (or if the held agent just dropped out).
  // Computed before the early returns so the stale-card effect below runs
  // unconditionally (Rules of Hooks).
  const leadRow = (lead && attention.find((s) => s.agentId === lead.agentId)) ?? attention[0];
  // The lead's full narration — present only when the server attached
  // `turnTextFull` (strictly more than the one-line goal). Only working leads
  // carry live activity.
  const leadFull = leadRow?.main === "working" ? leadRow.activity?.turnTextFull : undefined;
  // Forget a stale open-card key so the card never silently re-opens on its own:
  // once the agent that owned it is no longer a working lead with a full
  // narration (it switched away, or its narration shrank back below the
  // "has more" threshold mid-turn), drop the open state instead of letting a
  // later re-cross of that threshold re-materialize the card.
  useEffect(() => {
    if (cardOpenFor !== null && !(leadFull && leadRow?.agentId === cardOpenFor)) {
      setCardOpenFor(null);
    }
  }, [cardOpenFor, leadFull, leadRow?.agentId]);

  if (attention.length === 0) return null; // all quiet → hidden
  if (!leadRow) return null; // unreachable (attention is non-empty) — narrows the type
  const others = attention.filter((s) => s.agentId !== leadRow.agentId);
  const cardOpen = cardOpenFor === leadRow.agentId;

  return (
    <div
      className="fade-in flex flex-col"
      style={{
        position: "relative", // anchor for the full-narration card floating above
        marginBottom: "var(--sp-1)",
        paddingBottom: "var(--sp-1)",
        gap: "var(--sp-1)",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      {cardOpen && leadFull ? (
        <TurnTextCard
          status={leadRow}
          name={nameFor(agents)(leadRow.agentId)}
          full={leadFull}
          triggerRef={cardTriggerRef}
          onClose={closeCard}
        />
      ) : null}
      <div className="flex items-center" style={{ gap: "var(--sp-1_5)" }}>
        <RailRow status={leadRow} nameOf={nameFor(agents)} mounted={mounted} />
        {leadFull ? (
          <button
            type="button"
            ref={cardTriggerRef}
            aria-label={cardOpen ? "Collapse full narration" : "Expand full narration"}
            aria-expanded={cardOpen}
            onClick={() => setCardOpenFor((cur) => (cur === leadRow.agentId ? null : leadRow.agentId))}
            className="inline-flex shrink-0 items-center"
            style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", color: "var(--fg-4)" }}
          >
            {/* A distinct unfold glyph (not a single chevron) so it never reads
                as, or collides with, the adjacent `+N` expand chevron. */}
            <ChevronsUpDown className="h-3.5 w-3.5" />
          </button>
        ) : null}
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
          {/* `others`, NOT `attention`: the lead already has its own always-on
              row above, so mapping the full set here would render the lead a
              second time (the duplicate-row bug). */}
          {others.map((s) => (
            <RailRow key={s.agentId} status={s} nameOf={nameFor(agents)} mounted={mounted} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function nameFor(agents: ChatParticipantDetail[]) {
  return (id: string) => agents.find((a) => a.agentId === id)?.displayName ?? id.slice(0, 8);
}

/** One rail line: a single clickable text region that jumps to the agent's
 *  timeline anchor (working → WorkingTurn, failed → ErrorRow). */
function RailRow({
  status,
  nameOf,
  mounted,
}: {
  status: AgentChatStatus;
  nameOf: (id: string) => string;
  mounted: ReadonlySet<string>;
}) {
  const view = viewOf(status.main);
  const reasonView = statusReasonView(status);
  const colorVar = reasonView?.colorVar ?? view.colorVar;
  const shape = reasonView?.shape ?? view.shape;
  const pulse = reasonView?.pulse ?? view.pulse;
  const label = reasonView?.label ?? view.label;
  const jumpable = isJumpable(mounted, status.main, status.agentId);
  return (
    <div className="flex min-w-0 flex-1 items-center" style={{ gap: "var(--sp-1_5)" }}>
      <TimelineJumpButton
        agentId={status.agentId}
        main={status.main}
        anchored={jumpable}
        ariaLabel={`Jump to ${nameOf(status.agentId)} in the timeline`}
        className="flex-1 text-caption"
        style={{ color: colorVar }}
      >
        <StatusGlyph colorVar={colorVar} shape={shape} pulse={pulse} size={8} ariaLabel={label} />
        <span className="shrink-0">{nameOf(status.agentId)}</span>
        <Sep />
        <LeadDetail status={status} />
      </TimelineJumpButton>
    </div>
  );
}

/** The detail after the name: a short reason (failed) or the live activity
 *  (working). */
function LeadDetail({ status }: { status: AgentChatStatus }) {
  if (status.statusReason) {
    const detail = status.statusReason.detail ?? status.statusReason.reasonCode;
    return (
      <span className="truncate" title={detail}>
        {status.statusReason.label}
      </span>
    );
  }
  if (status.main === "failed") return <span className="truncate">failed</span>;
  return <WorkingDetail activity={status.activity} />;
}

export function statusReasonView(status: AgentChatStatus) {
  const reason = status.statusReason;
  if (!reason) return null;
  if (reason.kind === "terminal") {
    return {
      colorVar: reason.severity === "error" ? "var(--state-error)" : "var(--state-blocked)",
      shape: "dot" as const,
      pulse: null,
      label: reason.label,
    };
  }
  if (reason.kind === "waiting") {
    return { colorVar: "var(--state-blocked)", shape: "pause" as const, pulse: null, label: reason.label };
  }
  return { colorVar: "var(--state-idle)", shape: "dot" as const, pulse: "working" as const, label: reason.label };
}

/**
 * working detail, goal-first: `<goal> · 🔧 Bash · npm test · 12s`.
 *
 * The agent's running narration (`turnText`) is its *goal* — what it's trying
 * to do — and leads, flexing to fill the rail (truncating first when space is
 * tight so the means + ticker survive). The live action (kind/detail) is the
 * *means* and trails with a kind icon; the wall-clock ticker is last. When the
 * turn has produced no prose yet (`turnText` absent — common when an agent opens
 * with tool calls), the means leads instead, so the line is never blank.
 */
function WorkingDetail({ activity }: { activity: LiveActivity | null }) {
  const elapsed = useLiveElapsed(activity?.startedAt ?? null);
  if (!activity) return <span className="truncate">Working</span>;
  const goal = activity.turnText ? stripInlineMarkdown(activity.turnText) : null;
  const action = activityAction(activity, goal !== null);
  return (
    <span className="inline-flex min-w-0 flex-1 items-center" style={{ gap: 4 }}>
      {goal ? (
        <span className="min-w-0 flex-1 truncate" title={goal}>
          {goal}
        </span>
      ) : null}
      {goal && action ? <Sep /> : null}
      {action}
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

/** Per-kind glyph for the live action: tool → wrench, thinking → brain,
 *  writing → pencil. Muted + small so it reads as a quiet "means" marker, not
 *  a button. */
function ActionIcon({ kind }: { kind: LiveActivity["kind"] }) {
  const Icon = kind === "tool_call" ? Wrench : kind === "thinking" ? Brain : Pencil;
  return <Icon className="h-3 w-3 shrink-0" style={{ color: "var(--fg-4)" }} aria-hidden="true" />;
}

/**
 * The live action segment (the *means*): `🔧 Bash · npm test`, `🧠 Thinking`,
 * or `✏ Writing`. Returns null when there's nothing to add beyond the goal —
 * i.e. the agent is writing prose and that prose IS the goal already shown, so
 * a redundant "Writing" is suppressed. Tool/arg render in the mono face; the
 * arg is path-aware-trimmed and width-capped server-side.
 */
function activityAction(activity: LiveActivity, hasGoal: boolean) {
  if (activity.kind === "thinking") {
    return (
      <span className="inline-flex shrink-0 items-center" style={{ gap: 4 }}>
        <ActionIcon kind="thinking" />
        <span>Thinking</span>
      </span>
    );
  }
  if (activity.kind === "assistant_text") {
    // Prose IS the goal — when it's already shown, don't repeat it as "Writing".
    if (hasGoal) return null;
    const text = activity.detail ? stripInlineMarkdown(activity.detail) : null;
    return (
      <span className="inline-flex min-w-0 flex-1 items-center" style={{ gap: 4 }}>
        <ActionIcon kind="assistant_text" />
        <span className="truncate">{text || "Writing"}</span>
      </span>
    );
  }
  // tool_call
  const arg = smartToolArg(activity.detail);
  return (
    <span className="inline-flex shrink-0 items-center" style={{ gap: 4 }}>
      <ActionIcon kind="tool_call" />
      <span className="mono shrink-0">{activity.label}</span>
      {arg ? (
        <>
          <Sep />
          <span className="mono shrink-0" style={{ color: "var(--fg-4)" }}>
            {arg}
          </span>
        </>
      ) : null}
    </span>
  );
}

/**
 * Path-aware trim for a tool arg: collapse a lone filesystem path to its
 * basename (`packages/web/src/foo.tsx` → `foo.tsx`) so the meaningful end shows
 * instead of a head-truncated prefix. Conservative — only fires for a single
 * token (no whitespace) that holds a `/`, isn't a URL, and wasn't already
 * truncated server-side (no trailing ellipsis); commands like `npm test` and
 * URLs pass through untouched.
 */
function smartToolArg(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  if (!detail.endsWith("…") && !/\s/.test(detail) && detail.includes("/") && !detail.includes("://")) {
    const base = detail.replace(/\/+$/, "").split("/").pop();
    if (base) return base;
  }
  return detail;
}

/** Muted "·" segment separator. */
function Sep() {
  return (
    <span aria-hidden="true" className="shrink-0" style={{ color: "var(--fg-4)" }}>
      ·
    </span>
  );
}

/**
 * Floating card that expands the lead's full multi-line narration (`turnTextFull`)
 * over the message stream, anchored to the status bar and floating upward. It is
 * absolutely positioned (out of flow) so opening it — and the live refresh while
 * it's open — never reflows the conversation. A non-modal awareness surface (like
 * the chat-summary popover), not a focus-trapping dialog: dismisses on Escape, a
 * press outside it (ignoring the trigger, which owns the toggle), or the lead
 * ceasing to be a working agent with a full narration (handled by the parent).
 */
function TurnTextCard({
  status,
  name,
  full,
  triggerRef,
  onClose,
}: {
  status: AgentChatStatus;
  name: string;
  full: string;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const elapsed = useLiveElapsed(status.activity?.startedAt ?? null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || cardRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    // Capture so the outside-press is seen before message-row handlers.
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose, triggerRef]);

  // Strip inline markdown per line so the block's line breaks survive.
  const body = full
    .split("\n")
    .map((line) => stripInlineMarkdown(line))
    .join("\n");

  return (
    <section
      ref={cardRef}
      aria-label={`${name} — full narration`}
      className="fade-in flex flex-col"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "calc(100% + var(--sp-1))",
        zIndex: 20,
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-dialog)",
        boxShadow: "var(--shadow-md)",
        maxHeight: "min(46vh, 26rem)",
        overflow: "hidden",
      }}
    >
      <div
        className="text-caption flex items-center"
        style={{
          gap: "var(--sp-1_5)",
          padding: "var(--sp-1_5) var(--sp-2)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
          color: "var(--fg-3)",
        }}
      >
        <StatusGlyph colorVar="var(--state-working)" shape="dot" pulse="working" size={7} ariaLabel="working" />
        <span className="shrink-0 font-semibold" style={{ color: "var(--fg-2)" }}>
          {name}
        </span>
        {/* Same live "means" segment the rail uses (goal-suppression off), so the
            card header and the rail read identically — no bespoke duplicate. */}
        {status.activity ? activityAction(status.activity, false) : null}
        {elapsed ? (
          <span className="mono shrink-0" style={{ marginLeft: "auto", color: "var(--fg-4)" }}>
            {elapsed}
          </span>
        ) : null}
      </div>
      <div
        className="text-body"
        style={{
          padding: "var(--sp-2)",
          overflowY: "auto",
          overscrollBehavior: "contain",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "var(--fg)",
        }}
      >
        {body}
      </div>
    </section>
  );
}
