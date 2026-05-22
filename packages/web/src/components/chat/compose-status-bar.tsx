import { type AgentChatStatus, type ChatParticipantDetail, compareMainStatus } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import { viewOf } from "../../lib/agent-status-view.js";
import { Button } from "../ui/button.js";
import { StatusGlyph } from "../ui/status-glyph.js";
import { AgentStatusPanel } from "./agent-status-panel.js";
import { WorkingChip } from "./working-chip.js";

/**
 * ComposeStatusBar — the awareness strip just above the composer (the focus
 * position when it's the human's turn). Surfaces only the states worth acting
 * on / watching: needs-you, failed, working; collapses entirely when every
 * agent is quiet (ready / offline). Compact by default — one line for the
 * highest-priority agent + a [Reply] for needs-you + a "+N" tail + a chevron
 * that expands the full per-agent board (the shared AgentStatusPanel, priority
 * ordered).
 *
 * Data is the same chat-level /agent-status query the sidebar and header use
 * (React-Query-deduped, admin-WS-live). The WS invalidation is throttled to
 * ~1s, so the line can't strobe even as tool calls tick; no extra debounce.
 */
const ATTENTION: ReadonlySet<string> = new Set(["needs_you", "failed", "working"]);

/**
 * The agents worth raising the bar for — needs-you / failed / working —
 * sorted highest-attention first (so `[0]` is the line the compact bar tops).
 * ready / paused / offline are filtered out (they never raise the bar).
 * Exported for tests.
 */
export function selectAttention(statuses: AgentChatStatus[]): AgentChatStatus[] {
  return statuses.filter((s) => ATTENTION.has(s.main)).sort((a, b) => compareMainStatus(a.main, b.main));
}

function scrollToPendingQuestion(): void {
  const els = document.querySelectorAll<HTMLElement>('[data-pending-question="true"]');
  els[els.length - 1]?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function ComposeStatusBar({
  chatId,
  agents,
  canManage,
}: {
  chatId: string;
  /** Non-human agent participants (for name lookup + the expanded panel). */
  agents: ChatParticipantDetail[];
  canManage: (agentId: string) => boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { data: statuses } = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    refetchInterval: 30_000,
  });

  const nameOf = (id: string) => agents.find((a) => a.agentId === id)?.displayName ?? id.slice(0, 8);

  const attention = selectAttention(statuses ?? []);

  const top = attention[0];
  if (!top) return null; // all agents quiet (ready / offline) → no bar
  const extra = attention.length - 1;

  return (
    <div className="fade-in" style={{ marginBottom: "var(--sp-1_5)" }}>
      <div
        className="flex items-center"
        style={{
          gap: "var(--sp-2)",
          padding: "var(--sp-1_5) var(--sp-2_5)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
          background: "var(--bg-sunken)",
        }}
      >
        <CompactSummary top={top} nameOf={nameOf} />
        <div className="flex shrink-0 items-center" style={{ gap: "var(--sp-1_5)", marginLeft: "auto" }}>
          {extra > 0 ? (
            <span className="mono text-caption" style={{ color: "var(--fg-4)" }}>
              +{extra}
            </span>
          ) : null}
          {top.main === "needs_you" ? (
            <Button type="button" variant="secondary" size="sm" onClick={scrollToPendingQuestion}>
              Reply
            </Button>
          ) : null}
          <button
            type="button"
            aria-label={expanded ? "Collapse agent status" : "Expand agent status"}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex shrink-0 items-center"
            style={{
              border: 0,
              background: "transparent",
              padding: "var(--sp-0_5)",
              cursor: "pointer",
              color: "var(--fg-4)",
            }}
          >
            <ChevronDown
              className="h-4 w-4"
              style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 150ms ease" }}
            />
          </button>
        </div>
      </div>

      {expanded ? (
        <div
          style={{
            marginTop: "var(--sp-1)",
            padding: "var(--sp-1)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-panel)",
            background: "var(--bg-sunken)",
          }}
        >
          <AgentStatusPanel chatId={chatId} agents={agents} canManage={canManage} order="priority" />
        </div>
      ) : null}
    </div>
  );
}

/** One-line summary of the highest-priority agent. The glyph carries the
 *  status colour/shape; the sentence keeps it scannable. */
function CompactSummary({ top, nameOf }: { top: AgentChatStatus; nameOf: (id: string) => string }) {
  const view = viewOf(top.main);
  const glyph = (
    <StatusGlyph colorVar={view.colorVar} shape={view.shape} pulse={view.pulse} size={8} ariaLabel={view.label} />
  );
  const wrap = (children: ReactNode) => (
    <span
      className="mono text-caption inline-flex min-w-0 items-center"
      style={{ gap: "var(--sp-1_5)", color: "var(--fg-2)" }}
    >
      {glyph}
      {children}
    </span>
  );

  if (top.main === "needs_you") {
    return wrap(<span className="truncate">{nameOf(top.agentId)} needs your reply</span>);
  }
  if (top.main === "failed") {
    return wrap(<span className="truncate">{nameOf(top.agentId)} failed</span>);
  }
  // working — drop WorkingChip's leading dot (the summary glyph already carries
  // the status point, same "no two dots on a row" rule as the AgentRow) and
  // prefix the activity with the state word: `<name> · Working · Bash · 0s`.
  return wrap(
    <>
      <span className="truncate">{nameOf(top.agentId)}</span>
      {top.activity ? <WorkingChip activity={top.activity} showDot={false} prefix="Working" /> : null}
    </>,
  );
}
