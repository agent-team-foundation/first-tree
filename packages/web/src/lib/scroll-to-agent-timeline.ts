import type { AgentMainStatus } from "@first-tree/shared";

const HIGHLIGHT_MS = 1600;
const highlightTimers = new WeakMap<HTMLElement, number>();

type TimelineJumpOptions = {
  /** Move focus to the evidence target after keyboard activation. */
  focus?: boolean;
};

/**
 * Best-effort jump to an agent's place in the chat timeline, by the per-agent
 * anchor a status maps to: working → its WorkingTurn (`data-working-agent`),
 * failed → its ErrorRow (`data-error-agent`). No-op for states with no
 * timeline target (ready / paused / offline) or when the anchor isn't
 * currently mounted (e.g. a working card whose turn already ended). Shared by
 * the compose rail and the sidebar AgentRow so "click a status → see its
 * context" works the same way in both.
 */
export function scrollToAgentTimeline(agentId: string, main: AgentMainStatus, options: TimelineJumpOptions = {}): void {
  const attr = main === "failed" ? "data-error-agent" : main === "working" ? "data-working-agent" : null;
  if (!attr) return;
  const els = document.querySelectorAll<HTMLElement>(`[${attr}="${agentId}"]`);
  const target = els[els.length - 1];
  if (!target) return;

  target.scrollIntoView({ behavior: "smooth", block: "center" });

  // Restart a brief evidence highlight on repeat jumps. It lives on the target
  // rather than the inspector, so the user's eye lands where the activity came
  // from after the overlay closes.
  const previousTimer = highlightTimers.get(target);
  if (previousTimer !== undefined) window.clearTimeout(previousTimer);
  target.removeAttribute("data-timeline-jump-highlight");
  // Force the animation to restart if the same row is selected twice quickly.
  void target.offsetWidth;
  target.setAttribute("data-timeline-jump-highlight", "true");
  const timer = window.setTimeout(() => {
    target.removeAttribute("data-timeline-jump-highlight");
    highlightTimers.delete(target);
  }, HIGHLIGHT_MS);
  highlightTimers.set(target, timer);

  if (options.focus) {
    const hadTabIndex = target.hasAttribute("tabindex");
    if (!hadTabIndex) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    if (!hadTabIndex) {
      target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
    }
  }
}
