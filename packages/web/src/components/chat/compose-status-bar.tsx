import {
  type AgentChatStatus,
  type ChatParticipantDetail,
  compareMainStatus,
  type LiveActivity,
} from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, RotateCcw } from "lucide-react";
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import { chatCurrentTurnNarrationsQueryKey, listChatCurrentTurnNarrations } from "../../api/sessions.js";
import { viewOf } from "../../lib/agent-status-view.js";
import { stripInlineMarkdown } from "../../lib/strip-inline-markdown.js";
import { Markdown } from "../ui/markdown.js";
import { StatusGlyph } from "../ui/status-glyph.js";

/**
 * The composer's connected answer to “what is happening now?”.
 *
 * The compact row shows one current status and the latest one-line preview.
 * Expanding reveals complete current-turn narration inline, inside the same
 * visual shell as the composer. It is not a dialog and it does not duplicate
 * tool metadata once narration exists. Quiet chats render no status section.
 */
const ATTENTION: ReadonlySet<string> = new Set(["failed", "working"]);
const LEAD_HOLD_MS = 4000;

function visibleStatusReason(status: AgentChatStatus): AgentChatStatus["statusReason"] {
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
 * Hold an ordinary working lead briefly so rapid multi-agent updates do not
 * make the connected row flicker. Failures and provider reasons preempt it.
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
  agents: ChatParticipantDetail[];
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [lead, setLead] = useState<{ agentId: string; since: number } | null>(null);
  const detailId = useId();
  const activeChatIdRef = useRef(chatId);
  const sectionRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const toggleHadFocusRef = useRef(false);
  const { data: rawStatuses } = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    refetchInterval: 30_000,
  });
  const statuses = rawStatuses ?? [];
  const attention = useMemo(() => selectAttention(statuses), [statuses]);
  const nameOf = useMemo(() => nameFor(agents), [agents]);
  const announcement = useMemo(() => statusAnnouncement(attention, nameOf), [attention, nameOf]);
  const narrationQuery = useQuery({
    queryKey: chatCurrentTurnNarrationsQueryKey(chatId),
    queryFn: () => listChatCurrentTurnNarrations(chatId),
    enabled: expanded && attention.length > 0,
    staleTime: Infinity,
  });
  const narrationByAgent = useMemo(
    () => new Map((narrationQuery.data ?? []).map((narration) => [narration.agentId, narration.text])),
    [narrationQuery.data],
  );

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
    if (attention.length > 0) return;
    setExpanded(false);
    if (!toggleHadFocusRef.current) return;
    toggleHadFocusRef.current = false;
    const frame = requestAnimationFrame(() => fallbackFocusRef?.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [attention.length, fallbackFocusRef]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !sectionRef.current?.contains(event.target as Node | null)) return;
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false);
      toggleRef.current?.focus();
    };
    // Capture before sibling overlays (chat details, lightboxes) see Escape.
    // The connected output owns the key only while focus is inside it, so one
    // press collapses this layer without cascading into an older open layer.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [expanded]);

  const leadRow = (lead && attention.find((status) => status.agentId === lead.agentId)) ?? attention[0];

  return (
    <>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
      {leadRow ? (
        <section ref={sectionRef} className="compose-status-section fade-in" data-compose-status-bar>
          <button
            ref={toggleRef}
            type="button"
            aria-controls={detailId}
            aria-expanded={expanded}
            aria-label={toggleAccessibleName(expanded, leadRow, nameOf(leadRow.agentId), attention.length)}
            onClick={() => setExpanded((open) => !open)}
            onFocus={() => {
              toggleHadFocusRef.current = true;
            }}
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (next instanceof Node && sectionRef.current?.contains(next)) return;
              toggleHadFocusRef.current = false;
            }}
            className="compose-status-toggle flex w-full min-w-0 items-center text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <LeadSnapshot status={leadRow} name={nameOf(leadRow.agentId)} />
            {attention.length > 1 ? (
              <span className="compose-status-count text-caption shrink-0" style={{ color: "var(--fg-3)" }}>
                {attention.length - 1} more
              </span>
            ) : null}
            <ChevronDown
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 transition-transform"
              style={{ color: "var(--fg-3)", transform: expanded ? "rotate(180deg)" : "none" }}
            />
          </button>

          {expanded ? (
            <section id={detailId} aria-label="Current agent output" className="compose-status-detail">
              {narrationQuery.isPending ? (
                <StatusNotice>Loading current output…</StatusNotice>
              ) : narrationQuery.isError ? (
                <div className="compose-status-load-error flex items-center text-label" style={{ gap: "var(--sp-2)" }}>
                  <span style={{ color: "var(--state-error)" }}>Couldn&apos;t load current output.</span>
                  <button
                    type="button"
                    onClick={() => void narrationQuery.refetch()}
                    className="inline-flex items-center rounded-[var(--radius-input)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    style={{ gap: "var(--sp-1)", color: "var(--fg-2)" }}
                  >
                    <RotateCcw aria-hidden="true" className="h-3 w-3" />
                    Retry
                  </button>
                </div>
              ) : (
                attention.map((status, index) => (
                  <ExpandedAgent
                    key={status.agentId}
                    status={status}
                    name={nameOf(status.agentId)}
                    narration={narrationByAgent.get(status.agentId) ?? null}
                    divided={index > 0}
                  />
                ))
              )}
            </section>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function nameFor(agents: ChatParticipantDetail[]) {
  return (agentId: string) => agents.find((agent) => agent.agentId === agentId)?.displayName ?? agentId.slice(0, 8);
}

function statusAnnouncement(attention: AgentChatStatus[], nameOf: (agentId: string) => string): string {
  const count = `${attention.length} ${attention.length === 1 ? "agent update" : "agent updates"}`;
  const states = [...attention]
    .sort((a, b) => a.agentId.localeCompare(b.agentId))
    .map((status) => `${nameOf(status.agentId)} ${visibleStatusReason(status)?.label ?? stateLabel(status)}`)
    .join(". ");
  return states ? `Agent status updated: ${count}. ${states}.` : `Agent status updated: ${count}.`;
}

function LeadSnapshot({ status, name }: { status: AgentChatStatus; name: string }) {
  const visual = statusVisual(status);
  const preview = collapsedPreview(status);
  return (
    <div className="text-caption flex min-w-0 flex-1 items-center" style={{ gap: "var(--sp-1_5)" }}>
      <StatusGlyph colorVar={visual.colorVar} shape={visual.shape} pulse={visual.pulse} size={8} />
      <span className="compose-status-agent-name shrink-0 font-semibold" style={{ color: "var(--fg-2)" }}>
        {name}
      </span>
      <span className="compose-status-state inline-flex shrink-0 items-center" style={{ gap: "var(--sp-1_5)" }}>
        <Sep />
        <span style={{ color: "var(--fg-3)" }}>{statusStateLabel(status)}</span>
      </span>
      {preview ? (
        <>
          <Sep />
          <span className="truncate" title={preview} style={{ color: "var(--fg-2)" }}>
            {preview}
          </span>
        </>
      ) : null}
    </div>
  );
}

function ExpandedAgent({
  status,
  name,
  narration,
  divided,
}: {
  status: AgentChatStatus;
  name: string;
  narration: string | null;
  divided: boolean;
}) {
  const visual = statusVisual(status);
  const reason = visibleStatusReason(status);
  const fallback = expandedFallback(status);
  return (
    <article className={divided ? "compose-status-agent compose-status-agent-divided" : "compose-status-agent"}>
      <div className="text-label flex min-w-0 items-center" style={{ gap: "var(--sp-1_5)" }}>
        <StatusGlyph colorVar={visual.colorVar} shape={visual.shape} pulse={visual.pulse} size={7} />
        <span className="font-semibold" style={{ color: "var(--fg-2)", overflowWrap: "anywhere" }}>
          {name}
        </span>
        <span className="shrink-0" style={{ color: "var(--fg-3)" }}>
          {statusStateLabel(status)}
        </span>
      </div>
      {reason ? (
        <div className="text-label" style={{ marginTop: "var(--sp-1)", color: "var(--fg-3)" }}>
          {reason.label}
          {reason.detail ? ` · ${stripInlineMarkdown(reason.detail)}` : null}
        </div>
      ) : null}
      {narration ? (
        <Markdown className="compose-status-markdown text-body [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {narration}
        </Markdown>
      ) : fallback ? (
        <div
          className={fallback.mono ? "mono text-label" : "text-body"}
          style={{ marginTop: "var(--sp-1_5)", color: "var(--fg-2)", overflowWrap: "anywhere" }}
        >
          {fallback.text}
        </div>
      ) : null}
    </article>
  );
}

function StatusNotice({ children }: { children: string }) {
  return (
    <div className="text-label" style={{ color: "var(--fg-3)" }}>
      {children}
    </div>
  );
}

function stateLabel(status: AgentChatStatus): string {
  return viewOf(status.main).label;
}

function statusStateLabel(status: AgentChatStatus): string {
  const reason = visibleStatusReason(status);
  if (!reason) return stateLabel(status);
  if (reason.kind === "waiting") return "Waiting";
  if (reason.kind === "retrying") return "Retrying";
  return reason.severity === "error" ? "Failed" : "Stopped";
}

function toggleAccessibleName(
  expanded: boolean,
  status: AgentChatStatus,
  name: string,
  attentionCount: number,
): string {
  const action = expanded ? "Collapse" : "Expand";
  const preview = collapsedPreview(status);
  const more = attentionCount > 1 ? `. ${attentionCount - 1} more agent updates` : "";
  return `${action} current agent output. ${name} ${statusStateLabel(status)}${preview ? `. ${preview}` : ""}${more}`;
}

function statusVisual(status: AgentChatStatus) {
  const view = viewOf(status.main);
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

function narrationPreview(status: AgentChatStatus): string | null {
  const narration = status.activity?.turnText;
  return narration ? stripInlineMarkdown(narration) : null;
}

function collapsedPreview(status: AgentChatStatus): string | null {
  const reason = visibleStatusReason(status);
  if (reason) return reason.label;
  if (status.main === "failed") return "Session failed";
  const narration = narrationPreview(status);
  if (narration) return narration;
  return status.activity ? activityFallback(status.activity) : null;
}

function expandedFallback(status: AgentChatStatus): { text: string; mono: boolean } | null {
  if (status.main === "failed") return { text: "Session failed", mono: false };
  if (visibleStatusReason(status)) return null;
  if (!status.activity) return { text: "Working", mono: false };
  const text = activityFallback(status.activity);
  return text ? { text, mono: status.activity.kind === "tool_call" } : null;
}

function activityFallback(activity: LiveActivity): string | null {
  if (activity.kind === "thinking") return "Thinking";
  if (activity.kind === "assistant_text") {
    return activity.detail ? stripInlineMarkdown(activity.detail) : "Writing";
  }
  const detail = smartToolArg(activity.detail);
  return detail ? `${activity.label} · ${detail}` : activity.label;
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
