import type { AgentMainStatus } from "@first-tree/shared";

/**
 * Best-effort jump to an agent's place in the chat timeline, by the per-agent
 * anchor a status maps to: working → its WorkingTurn (`data-working-agent`),
 * needs-you → its question card (`data-pending-question-agent`), failed → its
 * ErrorRow (`data-error-agent`). No-op for states with no timeline target
 * (ready / paused / offline) or when the anchor isn't currently mounted (e.g.
 * a working card whose turn already ended). Shared by the compose rail and the
 * sidebar AgentRow so "click a status → see its context" works the same way
 * in both.
 */
export function scrollToAgentTimeline(agentId: string, main: AgentMainStatus): void {
  const attr =
    main === "needs_you"
      ? "data-pending-question-agent"
      : main === "failed"
        ? "data-error-agent"
        : main === "working"
          ? "data-working-agent"
          : null;
  if (!attr) return;
  const els = document.querySelectorAll<HTMLElement>(`[${attr}="${agentId}"]`);
  els[els.length - 1]?.scrollIntoView({ behavior: "smooth", block: "center" });
}
