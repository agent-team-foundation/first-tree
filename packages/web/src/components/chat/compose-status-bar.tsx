import {
  type AgentChatStatus,
  type ChatParticipantDetail,
  compareMainStatus,
  type LiveActivity,
} from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { Brain, ChevronDown, Pencil, Wrench } from "lucide-react";
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import { viewOf } from "../../lib/agent-status-view.js";
import { stripInlineMarkdown } from "../../lib/strip-inline-markdown.js";
import { isJumpable, type TimelineAnchorKind, useMountedAnchors } from "../../lib/use-mounted-anchors.js";
import { Markdown } from "../ui/markdown.js";
import { StatusGlyph } from "../ui/status-glyph.js";
import { TimelineJumpButton } from "./timeline-jump-button.js";

/**
 * ComposeStatusBar is the stable answer to “what are the agents doing now?”.
 *
 * The compact row is the top edge of the composer: it shows one live snapshot
 * and expands in place to the current output for every actionable agent. This
 * is a status projection, not another timeline or a floating inspector.
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
  composerInputRef,
}: {
  chatId: string;
  /** Non-human agent participants, used for stable display-name lookup. */
  agents: ChatParticipantDetail[];
  /** Stable composer control that receives focus if the status surface vanishes. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  /** Editable composer input whose focus signals that monitoring is finished. */
  composerInputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [lead, setLead] = useState<{ agentId: string; since: number } | null>(null);
  const detailsId = useId();
  const activeChatIdRef = useRef(chatId);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const focusWithinRef = useRef(false);
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
    setExpanded(false);
  }, [chatId]);

  useEffect(() => {
    if (!composerInputRef) return;
    const collapseForComposerFocus = (event: FocusEvent) => {
      if (event.target === composerInputRef.current) setExpanded(false);
    };
    document.addEventListener("focusin", collapseForComposerFocus);
    return () => document.removeEventListener("focusin", collapseForComposerFocus);
  }, [composerInputRef]);

  useEffect(() => {
    if (attention.length === 0) return;
    const clearOutsidePointerFocus = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !surfaceRef.current?.contains(target)) focusWithinRef.current = false;
    };
    document.addEventListener("pointerdown", clearOutsidePointerFocus, true);
    return () => document.removeEventListener("pointerdown", clearOutsidePointerFocus, true);
  }, [attention.length]);

  useEffect(() => {
    if (attention.length === 0) {
      setExpanded(false);
      if (!focusWithinRef.current) return;
      focusWithinRef.current = false;
      fallbackFocusRef?.current?.focus();
      return;
    }
    if (!expanded || !focusWithinRef.current) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.isConnected && surfaceRef.current?.contains(active)) {
      const activeJump = active.closest<HTMLElement>(".compose-status-jump");
      if (!activeJump) return;
      const activeAgentId = activeJump.closest<HTMLElement>("[data-current-output-agent]")?.dataset.currentOutputAgent;
      const focusedStatus = attention.find((status) => status.agentId === activeAgentId);
      if (focusedStatus && isJumpable(mounted, timelineTarget(focusedStatus), focusedStatus.agentId)) return;
    }
    const frame = requestAnimationFrame(() => triggerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [attention, expanded, fallbackFocusRef, mounted]);

  const leadRow = (lead && attention.find((status) => status.agentId === lead.agentId)) ?? attention[0];
  const disclosureStatus = leadRow
    ? expanded && attention.length > 1
      ? expandedGroupState(attention)
      : [nameOf(leadRow.agentId), stateLabel(leadRow), visibleStatusReason(leadRow)?.label].filter(Boolean).join(", ")
    : "";

  return (
    <>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>

      {leadRow ? (
        <section
          ref={surfaceRef}
          className="compose-status-surface fade-in"
          data-compose-status-bar
          onFocusCapture={() => {
            focusWithinRef.current = true;
          }}
          onBlurCapture={(event) => {
            const next = event.relatedTarget;
            if (next instanceof HTMLElement && next !== document.body && !event.currentTarget.contains(next)) {
              focusWithinRef.current = false;
            }
          }}
        >
          <button
            ref={triggerRef}
            type="button"
            aria-controls={detailsId}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} current agent output, ${attention.length} actionable ${attention.length === 1 ? "agent" : "agents"}, ${disclosureStatus}`}
            onClick={() => setExpanded((open) => !open)}
            className="compose-status-summary flex w-full min-w-0 items-center text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {expanded && attention.length > 1 ? (
              <ExpandedGroupSnapshot statuses={attention} />
            ) : (
              <LeadSnapshot status={leadRow} name={nameOf(leadRow.agentId)} showSummary={!expanded} />
            )}
            {!expanded && attention.length > 1 ? (
              <span className="text-caption shrink-0" style={{ color: "var(--fg-3)" }}>
                {attention.length} agents
              </span>
            ) : null}
            <ChevronDown
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 transition-transform"
              style={{ color: "var(--fg-3)", transform: expanded ? "none" : "rotate(180deg)" }}
            />
          </button>

          {expanded ? (
            <CurrentOutputDetails
              id={detailsId}
              attention={attention}
              nameOf={nameOf}
              mounted={mounted}
              onTimelineNavigate={() => {
                // A pointer jump does not transfer focus to timeline evidence.
                // Clear ownership before its focused button is unmounted so a
                // later status removal cannot steal focus back to the composer.
                focusWithinRef.current = false;
                setExpanded(false);
              }}
            />
          ) : null}
        </section>
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
  return states ? `Agent status updated: ${count}. ${states}.` : `Agent status updated: ${count}.`;
}

function LeadSnapshot({ status, name, showSummary }: { status: AgentChatStatus; name: string; showSummary: boolean }) {
  const visual = statusVisual(status);
  const summary = collapsedSummary(status);
  return (
    <div className="text-caption flex min-w-0 flex-1 items-center" style={{ gap: "var(--sp-1_5)" }}>
      <StatusGlyph colorVar={visual.colorVar} shape={visual.shape} pulse={visual.pulse} size={8} />
      <span className="compose-status-agent-name shrink-0 font-semibold" style={{ color: "var(--fg-2)" }}>
        {name}
      </span>
      <span
        className={`compose-status-state inline-flex shrink-0 items-center${showSummary ? "" : " compose-status-state-expanded"}`}
        style={{ gap: "var(--sp-1_5)" }}
      >
        <Sep />
        <span style={{ color: "var(--fg-3)" }}>{stateLabel(status)}</span>
      </span>
      {showSummary && summary ? (
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

function ExpandedGroupSnapshot({ statuses }: { statuses: AgentChatStatus[] }) {
  const lead = statuses[0];
  if (!lead) return null;
  const visual = statusVisual(lead);
  const state = expandedGroupState(statuses);

  return (
    <div className="text-caption flex min-w-0 flex-1 items-center" style={{ gap: "var(--sp-1_5)" }}>
      <StatusGlyph colorVar={visual.colorVar} shape={visual.shape} pulse={visual.pulse} size={8} />
      <span className="shrink-0 font-semibold" style={{ color: "var(--fg-2)" }}>
        {statuses.length} agents
      </span>
      <Sep />
      <span className="truncate" style={{ color: "var(--fg-3)" }}>
        {state}
      </span>
    </div>
  );
}

function expandedGroupState(statuses: AgentChatStatus[]): string {
  const failures = statuses.filter((status) => status.main === "failed").length;
  if (failures > 0) return `${failures} failed`;
  const statusUpdates = statuses.filter((status) => visibleStatusReason(status) !== undefined).length;
  if (statusUpdates > 0) return `${statusUpdates} status ${statusUpdates === 1 ? "update" : "updates"}`;
  return "Active";
}

function CurrentOutputDetails({
  id,
  attention,
  nameOf,
  mounted,
  onTimelineNavigate,
}: {
  id: string;
  attention: AgentChatStatus[];
  nameOf: (agentId: string) => string;
  mounted: ReadonlySet<string>;
  onTimelineNavigate: () => void;
}) {
  const showIdentity = attention.length > 1;
  return (
    <section
      id={id}
      aria-label="Current agent output"
      className="compose-status-details fade-in focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      data-current-agent-output
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need a focus target to scroll long plain-text output.
      tabIndex={0}
    >
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {attention.map((status, index) => (
          <li
            key={status.agentId}
            data-current-output-agent={status.agentId}
            style={{ borderTop: index === 0 ? 0 : "var(--hairline) solid var(--border-faint)" }}
          >
            <CurrentOutputItem
              status={status}
              name={nameOf(status.agentId)}
              mounted={mounted}
              showIdentity={showIdentity}
              onTimelineNavigate={onTimelineNavigate}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CurrentOutputItem({
  status,
  name,
  mounted,
  showIdentity,
  onTimelineNavigate,
}: {
  status: AgentChatStatus;
  name: string;
  mounted: ReadonlySet<string>;
  showIdentity: boolean;
  onTimelineNavigate: () => void;
}) {
  const visual = statusVisual(status);
  const snapshot = agentSnapshot(status);
  const jumpTarget = timelineTarget(status);
  const anchored = isJumpable(mounted, jumpTarget, status.agentId);
  return (
    <article
      className="compose-status-output"
      style={{ padding: "var(--sp-2_5) var(--sp-3)" }}
      title={snapshot.updateTitle}
    >
      {showIdentity ? (
        <div
          key="identity"
          className="compose-status-identity text-label flex min-w-0 items-center"
          style={{ gap: "var(--sp-1_5)" }}
          data-current-output-identity
        >
          <div className="flex min-w-0 flex-1 items-center" style={{ gap: "var(--sp-1_5)" }}>
            <StatusGlyph colorVar={visual.colorVar} shape={visual.shape} pulse={visual.pulse} size={7} />
            <span className="font-semibold" style={{ color: "var(--fg-2)", overflowWrap: "anywhere" }}>
              {name}
            </span>
            <span className="shrink-0" style={{ color: "var(--fg-3)" }}>
              {stateLabel(status)}
            </span>
          </div>
        </div>
      ) : null}
      {anchored ? (
        <TimelineJumpButton
          key="timeline-jump"
          agentId={status.agentId}
          target={jumpTarget}
          anchored
          ariaLabel={`View ${name} in the timeline`}
          onNavigate={onTimelineNavigate}
          className="compose-status-jump"
          interactiveClassName="rounded-[var(--radius-input)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="sr-only">View in the timeline</span>
        </TimelineJumpButton>
      ) : null}

      <Markdown
        key="narration"
        className={`compose-status-narration text-body${anchored ? " compose-status-narration-with-jump" : ""}`}
      >
        {snapshot.update}
      </Markdown>
      {snapshot.meta ? <ActivityMetaLine meta={snapshot.meta} /> : null}
    </article>
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

function narrationOf(status: AgentChatStatus, full = false): string | null {
  const narration = full ? (status.activity?.turnTextFull ?? status.activity?.turnText) : status.activity?.turnText;
  if (!narration) return null;
  return full ? narration : stripInlineMarkdown(narration);
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
  const narration = narrationOf(status, true);
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
  if (hasNarration) return null;
  if (activity.kind === "thinking") return { kind: "thinking", label: "Thinking" };
  if (activity.kind === "assistant_text") {
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
