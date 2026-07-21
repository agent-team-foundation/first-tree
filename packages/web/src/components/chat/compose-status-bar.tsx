import {
  type AgentChatStatus,
  type ChatParticipantDetail,
  compareMainStatus,
  type LiveActivity,
} from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { Brain, ChevronDown, Pencil, Wrench, X } from "lucide-react";
import { type Ref, type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import { viewOf } from "../../lib/agent-status-view.js";
import { stripInlineMarkdown } from "../../lib/strip-inline-markdown.js";
import { isJumpable, type TimelineAnchorKind, useMountedAnchors } from "../../lib/use-mounted-anchors.js";
import { StatusGlyph } from "../ui/status-glyph.js";
import { TimelineJumpButton } from "./timeline-jump-button.js";

/**
 * ComposeStatusBar is the stable answer to “what are the agents doing now?”.
 *
 * The collapsed strip keeps one invariant structure: lead snapshot on the left,
 * `Activity (N)` on the right. The explicit Activity control always opens the
 * same live inspector, regardless of viewport or agent count. The inspector is
 * intentionally a current-state index, not another timeline: every agent gets
 * one compact item with at most two lines of latest narration plus its current
 * tool/reason. Full narration and activity history remain in the timeline.
 *
 * Only working, failed, waiting, retrying, and terminal-reason states raise the
 * strip. When every participant is quiet, the strip disappears.
 */
const ATTENTION: ReadonlySet<string> = new Set(["failed", "working"]);
const LEAD_HOLD_MS = 4000;

function visibleStatusReason(status: AgentChatStatus): AgentChatStatus["statusReason"] {
  // A working event is newer evidence than a terminal resume/turn reason. Keep
  // the stale terminal detail out of the live surface until working ends.
  if (status.main === "working" && status.statusReason?.kind === "terminal") return undefined;
  return status.statusReason;
}

function activityStartedMs(status: AgentChatStatus): number {
  const value = status.activity ? new Date(status.activity.startedAt).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}

/** Active or actionable agents, ordered by the attention the user needs now. */
export function selectAttention(statuses: AgentChatStatus[]): AgentChatStatus[] {
  return statuses
    .filter((status) => ATTENTION.has(status.main) || visibleStatusReason(status) !== undefined)
    .sort(
      (a, b) =>
        attentionRank(a) - attentionRank(b) ||
        activityStartedMs(b) - activityStartedMs(a) ||
        compareMainStatus(a.main, b.main),
    );
}

function attentionRank(status: AgentChatStatus): number {
  const reason = visibleStatusReason(status);
  if (status.main === "failed" || isFatalStatusReason(status)) return 0;
  if (reason?.kind === "terminal") return 1;
  if (reason?.kind === "waiting") return 2;
  if (reason?.kind === "retrying") return 3;
  if (status.main === "working") return 4;
  return 5;
}

function isFatalStatusReason(status: AgentChatStatus): boolean {
  const reason = visibleStatusReason(status);
  return reason?.kind === "terminal" && reason.severity === "error";
}

/**
 * Pick the strip lead with anti-flicker, given the previously held lead.
 * Priority states (failure/wait/retry/terminal) preempt immediately. Among
 * ordinary working agents, the most recently active candidate waits for the
 * short hold to elapse before replacing a still-working lead.
 */
export function pickLead(
  current: { agentId: string; since: number } | null,
  now: number,
  priority: AgentChatStatus[],
  working: AgentChatStatus[],
  holdMs: number,
): { agentId: string; since: number } | null {
  const priorityLead = priority[0];
  if (priorityLead) return { agentId: priorityLead.agentId, since: now };
  const mostRecent = [...working].sort((a, b) => activityStartedMs(b) - activityStartedMs(a))[0];
  if (!mostRecent) return null;
  const heldStillWorking = current !== null && working.some((status) => status.agentId === current.agentId);
  if (heldStillWorking && now - current.since < holdMs) return current;
  return { agentId: mostRecent.agentId, since: now };
}

export function ComposeStatusBar({
  chatId,
  agents,
  fallbackFocusRef,
}: {
  chatId: string;
  /** Non-human agent participants, used for stable display-name lookup. */
  agents: ChatParticipantDetail[];
  /** Stable composer control that receives focus if the activity bar vanishes. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [lead, setLead] = useState<{ agentId: string; since: number } | null>(null);
  const inspectorId = useId();
  const activeChatIdRef = useRef(chatId);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const focusWithinRef = useRef(false);
  const closeInspector = useCallback(() => {
    focusWithinRef.current = false;
    setInspectorOpen(false);
  }, []);
  const closeInspectorAndRestoreFocus = useCallback(() => {
    setInspectorOpen(false);
    triggerRef.current?.focus();
  }, []);
  const { data: rawStatuses } = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    refetchInterval: 30_000,
  });
  // The server's per-chat composite is the working/failed authority. Timeline
  // events and `activity` only explain that state; an un-ended local workgroup
  // must never resurrect Working after runtime freshness has expired.
  const statuses = rawStatuses ?? [];
  const attention = useMemo(() => selectAttention(statuses), [statuses]);
  const mounted = useMountedAnchors();
  const nameOf = useMemo(() => nameFor(agents), [agents]);
  const announcement = useMemo(() => activityAnnouncement(attention, nameOf), [attention, nameOf]);

  useEffect(() => {
    const priority = attention.filter(
      (status) => status.main === "failed" || visibleStatusReason(status) !== undefined,
    );
    const working = attention.filter(
      (status) => status.main === "working" && visibleStatusReason(status) === undefined,
    );
    const repick = () => setLead((previous) => pickLead(previous, Date.now(), priority, working, LEAD_HOLD_MS));
    repick();
    const timer = setTimeout(repick, LEAD_HOLD_MS);
    return () => clearTimeout(timer);
  }, [attention]);

  useEffect(() => {
    if (activeChatIdRef.current === chatId) return;
    activeChatIdRef.current = chatId;
    setInspectorOpen(false);
  }, [chatId]);

  useEffect(() => {
    if (attention.length === 0) {
      setInspectorOpen(false);
      if (!focusWithinRef.current) return;
      focusWithinRef.current = false;
      const frame = requestAnimationFrame(() => fallbackFocusRef?.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    if (!inspectorOpen || !focusWithinRef.current) return;
    const active = document.activeElement;
    const activeAgentId = active?.closest<HTMLElement>("[data-live-activity-agent]")?.dataset.liveActivityAgent;
    const focusedStatus = attention.find((status) => status.agentId === activeAgentId);
    const focusedRowSurvives =
      focusedStatus !== undefined && isJumpable(mounted, timelineTarget(focusedStatus), focusedStatus.agentId);
    if (
      active &&
      (triggerRef.current?.contains(active) ||
        (inspectorRef.current?.contains(active) && (activeAgentId === undefined || focusedRowSurvives)))
    ) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      inspectorRef.current?.querySelector<HTMLElement>(".compose-status-inspector-close")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [attention, fallbackFocusRef, inspectorOpen, mounted]);

  useEffect(() => {
    if (!inspectorOpen) return;
    const frame = requestAnimationFrame(() => {
      inspectorRef.current?.querySelector<HTMLElement>("button")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [inspectorOpen]);

  useEffect(() => {
    if (!inspectorOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (
        !(target instanceof Node) ||
        (!inspectorRef.current?.contains(target) && !triggerRef.current?.contains(target))
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeInspectorAndRestoreFocus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || inspectorRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeInspector();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [closeInspector, closeInspectorAndRestoreFocus, inspectorOpen]);

  const leadRow = (lead && attention.find((status) => status.agentId === lead.agentId)) ?? attention[0];

  return (
    <>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>

      {leadRow ? (
        <div
          className="fade-in"
          data-compose-status-bar
          onFocusCapture={() => {
            focusWithinRef.current = true;
          }}
          onBlurCapture={(event) => {
            const next = event.relatedTarget;
            // Removing the last actionable row temporarily moves browser focus to
            // body before the fallback-focus effect runs. Preserve the marker for
            // that removal transition; explicit outside pointer dismissal resets
            // it through closeInspector.
            if (next instanceof Node && next !== document.body && !event.currentTarget.contains(next)) {
              focusWithinRef.current = false;
            }
          }}
          style={{
            position: "relative",
            marginBottom: "var(--sp-1)",
            paddingBottom: "var(--sp-1)",
            borderBottom: "var(--hairline) solid var(--border-faint)",
          }}
        >
          <div className="flex min-w-0 items-center" style={{ gap: "var(--sp-2)" }}>
            <LeadSnapshot status={leadRow} name={nameOf(leadRow.agentId)} />
            <button
              ref={triggerRef}
              type="button"
              aria-controls={inspectorId}
              aria-expanded={inspectorOpen}
              aria-haspopup="dialog"
              aria-label={`${inspectorOpen ? "Close" : "Open"} agent activity, ${attention.length} actionable ${attention.length === 1 ? "agent" : "agents"}`}
              onClick={() => setInspectorOpen((open) => !open)}
              className="compose-status-activity-trigger text-label inline-flex shrink-0 items-center rounded-[var(--radius-input)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              style={{
                gap: "var(--sp-1)",
                border: 0,
                background: inspectorOpen ? "var(--bg-hover)" : "transparent",
                padding: "0 var(--sp-1_5)",
                cursor: "pointer",
                color: "var(--fg-3)",
              }}
            >
              <span>Activity ({attention.length})</span>
              <ChevronDown
                aria-hidden="true"
                className="h-3.5 w-3.5 transition-transform"
                style={{ transform: inspectorOpen ? "rotate(180deg)" : "none" }}
              />
            </button>
          </div>

          {/* Keep the panel after its disclosure trigger in DOM order. Its visual
              position is still above the composer, while forward Tab now enters
              Close → activity rows instead of skipping the panel entirely. */}
          {inspectorOpen ? (
            <LiveActivityInspector
              id={inspectorId}
              ref={inspectorRef}
              attention={attention}
              nameOf={nameOf}
              mounted={mounted}
              onClose={closeInspectorAndRestoreFocus}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function nameFor(agents: ChatParticipantDetail[]) {
  return (agentId: string) => agents.find((agent) => agent.agentId === agentId)?.displayName ?? agentId.slice(0, 8);
}

function activityAnnouncement(attention: AgentChatStatus[], nameOf: (agentId: string) => string): string {
  const count = `${attention.length} actionable ${attention.length === 1 ? "agent" : "agents"}`;
  const states = [...attention]
    .sort((a, b) => a.agentId.localeCompare(b.agentId))
    .map((status) => `${nameOf(status.agentId)} ${visibleStatusReason(status)?.label ?? stateLabel(status)}`)
    .join(". ");
  return states ? `Agent activity updated: ${count}. ${states}.` : `Agent activity updated: ${count}.`;
}

function LeadSnapshot({ status, name }: { status: AgentChatStatus; name: string }) {
  const visual = statusVisual(status);
  const summary = collapsedSummary(status);
  return (
    <div className="text-caption flex min-w-0 flex-1 items-center" style={{ gap: "var(--sp-1_5)" }}>
      <StatusGlyph colorVar={visual.colorVar} shape={visual.shape} pulse={visual.pulse} size={8} />
      <span className="compose-status-agent-name shrink-0 font-semibold" style={{ color: "var(--fg-2)" }}>
        {name}
      </span>
      <span className="compose-status-state inline-flex shrink-0 items-center" style={{ gap: "var(--sp-1_5)" }}>
        <Sep />
        <span style={{ color: "var(--fg-3)" }}>{stateLabel(status)}</span>
      </span>
      {summary ? (
        <>
          <Sep />
          <span className="truncate" title={summary} style={{ color: "var(--fg-2)" }}>
            {summary}
          </span>
        </>
      ) : null}
    </div>
  );
}

const LiveActivityInspector = function LiveActivityInspector({
  id,
  ref,
  attention,
  nameOf,
  mounted,
  onClose,
}: {
  id: string;
  ref: Ref<HTMLElement>;
  attention: AgentChatStatus[];
  nameOf: (agentId: string) => string;
  mounted: ReadonlySet<string>;
  onClose: () => void;
}) {
  return (
    <section
      id={id}
      ref={ref}
      role="dialog"
      aria-label="Agent activity"
      className="fade-in"
      data-live-activity-inspector
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "calc(100% + var(--sp-1))",
        zIndex: 30,
        overflow: "hidden",
        background: "var(--bg-raised)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-dialog)",
        boxShadow: "var(--shadow-md)",
      }}
    >
      <div
        className="flex items-center"
        style={{
          minHeight: "var(--sp-10)",
          gap: "var(--sp-2)",
          padding: "var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-2_5)",
          borderBottom: "var(--hairline) solid var(--border-faint)",
        }}
      >
        <span className="text-label font-semibold" style={{ color: "var(--fg-2)" }}>
          Agent activity · {attention.length} {attention.length === 1 ? "agent" : "agents"}
        </span>
        <button
          type="button"
          aria-label="Close agent activity"
          onClick={onClose}
          className="compose-status-inspector-close ml-auto inline-flex items-center justify-center rounded-[var(--radius-input)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{ border: 0, background: "transparent", cursor: "pointer", color: "var(--fg-3)" }}
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>
      <ul
        style={{
          maxHeight: "min(52vh, 20rem)",
          margin: 0,
          padding: 0,
          overflowY: "auto",
          overscrollBehavior: "contain",
          listStyle: "none",
        }}
      >
        {attention.map((status, index) => (
          <li
            key={status.agentId}
            data-live-activity-agent={status.agentId}
            style={{ borderTop: index === 0 ? 0 : "var(--hairline) solid var(--border-faint)" }}
          >
            <InspectorItem status={status} name={nameOf(status.agentId)} mounted={mounted} onNavigate={onClose} />
          </li>
        ))}
      </ul>
    </section>
  );
};

function InspectorItem({
  status,
  name,
  mounted,
  onNavigate,
}: {
  status: AgentChatStatus;
  name: string;
  mounted: ReadonlySet<string>;
  onNavigate: () => void;
}) {
  const visual = statusVisual(status);
  const snapshot = agentSnapshot(status);
  const jumpTarget = timelineTarget(status);
  const anchored = isJumpable(mounted, jumpTarget, status.agentId);
  const accessibleSummary = [
    name,
    stateLabel(status),
    snapshot.update,
    snapshot.meta ? formatActivityMeta(snapshot.meta) : null,
    "View in the timeline",
  ]
    .filter((part): part is string => part !== null)
    .join(". ");
  return (
    <TimelineJumpButton
      agentId={status.agentId}
      target={jumpTarget}
      anchored={anchored}
      ariaLabel={accessibleSummary}
      onNavigate={onNavigate}
      className="w-full text-left"
      interactiveClassName="transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      style={{ minHeight: "var(--sp-16)", padding: "var(--sp-2) var(--sp-2_5)" }}
    >
      <div className="min-w-0 flex-1">
        <div className="text-label flex min-w-0 items-center" style={{ gap: "var(--sp-1_5)" }}>
          <StatusGlyph colorVar={visual.colorVar} shape={visual.shape} pulse={visual.pulse} size={7} />
          <span className="font-semibold" style={{ color: "var(--fg-2)", overflowWrap: "anywhere" }}>
            {name}
          </span>
          <span className="shrink-0" style={{ color: "var(--fg-3)" }}>
            {stateLabel(status)}
          </span>
        </div>
        <div
          className="text-body"
          title={snapshot.updateTitle}
          style={{
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: 2,
            marginTop: "var(--sp-0_5)",
            overflow: "hidden",
            overflowWrap: "anywhere",
            color: "var(--fg-2)",
          }}
        >
          {snapshot.update}
        </div>
        {snapshot.meta ? <ActivityMetaLine meta={snapshot.meta} /> : null}
      </div>
    </TimelineJumpButton>
  );
}

function timelineTarget(status: AgentChatStatus): TimelineAnchorKind {
  if (status.main === "failed" || isFatalStatusReason(status)) return "failed";
  if (visibleStatusReason(status)) return "reason";
  return "working";
}

function stateLabel(status: AgentChatStatus): string {
  return viewOf(status.main).label;
}

function statusVisual(status: AgentChatStatus) {
  const view = viewOf(status.main);
  // Reachability, lifecycle and actual failure keep their server-derived
  // shape. Reasons may tint ready/working activity, but cannot make an offline
  // or paused agent visually masquerade as a different main state.
  if (status.main === "offline" || status.main === "paused" || status.main === "failed") return view;
  const reasonView = statusReasonView(status);
  return {
    colorVar: reasonView?.colorVar ?? view.colorVar,
    shape: reasonView?.shape ?? view.shape,
    pulse: reasonView?.pulse ?? view.pulse,
  };
}

export function statusReasonView(status: AgentChatStatus) {
  const reason = visibleStatusReason(status);
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

type ActivityMeta = {
  kind?: LiveActivity["kind"];
  label: string;
  detail?: string;
  title?: string;
  mono?: boolean;
};

type AgentSnapshot = {
  update: string;
  updateTitle?: string;
  meta: ActivityMeta | null;
};

function narrationOf(status: AgentChatStatus): string | null {
  const narration = status.activity?.turnText;
  return narration ? stripInlineMarkdown(narration) : null;
}

function collapsedSummary(status: AgentChatStatus): string | null {
  const reason = visibleStatusReason(status);
  if (reason) return reason.label;
  if (status.main === "failed") return "Session failed";
  const narration = narrationOf(status);
  if (narration) return narration;
  const action = status.activity ? activityMeta(status.activity, false) : null;
  return action ? formatActivityMeta(action) : null;
}

function agentSnapshot(status: AgentChatStatus): AgentSnapshot {
  const narration = narrationOf(status);
  const reason = visibleStatusReason(status);
  if (reason) {
    const detail = reason.detail ? stripInlineMarkdown(reason.detail) : undefined;
    if (narration) {
      return {
        update: narration,
        meta: { label: reason.label, detail, title: detail ?? reason.reasonCode },
      };
    }
    return {
      update: reason.label,
      updateTitle: detail ?? reason.reasonCode,
      meta: detail ? { label: detail, title: detail } : null,
    };
  }
  if (status.main === "failed") return { update: "Session failed", meta: null };
  const action = status.activity ? activityMeta(status.activity, narration !== null) : null;
  if (narration) return { update: narration, meta: action };
  if (action) return { update: formatActivityMeta(action), meta: null };
  return { update: "Working", meta: null };
}

function activityMeta(activity: LiveActivity, hasNarration: boolean): ActivityMeta | null {
  if (activity.kind === "thinking") return { kind: "thinking", label: "Thinking" };
  if (activity.kind === "assistant_text") {
    if (hasNarration) return null;
    return {
      kind: "assistant_text",
      label: activity.detail ? stripInlineMarkdown(activity.detail) : "Writing",
    };
  }
  return {
    kind: "tool_call",
    label: activity.label,
    detail: smartToolArg(activity.detail),
    title: activity.detail,
    mono: true,
  };
}

function formatActivityMeta(meta: ActivityMeta): string {
  return meta.detail ? `${meta.label} · ${meta.detail}` : meta.label;
}

function ActivityMetaLine({ meta }: { meta: ActivityMeta }) {
  return (
    <div
      className="text-label flex min-w-0 items-center"
      title={meta.title}
      style={{ gap: "var(--sp-1)", marginTop: "var(--sp-0_5)", color: "var(--fg-3)" }}
    >
      {meta.kind ? <ActionIcon kind={meta.kind} /> : null}
      <span className={meta.mono ? "mono shrink-0" : "truncate"}>{meta.label}</span>
      {meta.detail ? (
        <>
          <Sep />
          <span className={meta.mono ? "mono truncate" : "truncate"}>{meta.detail}</span>
        </>
      ) : null}
    </div>
  );
}

function ActionIcon({ kind }: { kind: LiveActivity["kind"] }) {
  const Icon = kind === "tool_call" ? Wrench : kind === "thinking" ? Brain : Pencil;
  return <Icon aria-hidden="true" className="h-3 w-3 shrink-0" />;
}

/** Collapse a lone filesystem path to its meaningful basename. */
function smartToolArg(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  if (!detail.endsWith("…") && !/\s/.test(detail) && detail.includes("/") && !detail.includes("://")) {
    const base = detail.replace(/\/+$/, "").split("/").pop();
    if (base) return base;
  }
  return detail;
}

function Sep() {
  return (
    <span aria-hidden="true" className="shrink-0" style={{ color: "var(--fg-4)" }}>
      ·
    </span>
  );
}
