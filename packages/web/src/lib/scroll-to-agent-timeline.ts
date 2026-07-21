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
 * failed → its fatal ErrorRow (`data-error-agent`), and provider reason → its
 * waiting/retrying/warning ErrorRow (`data-status-reason-agent`). No-op when
 * the anchor is not currently mounted. Shared by the compose Inspector and
 * any future status surface that needs the same evidence jump.
 */
export function scrollToAgentTimeline(
  agentId: string,
  main: AgentMainStatus | "reason",
  options: TimelineJumpOptions = {},
): void {
  const attr =
    main === "failed"
      ? "data-error-agent"
      : main === "working"
        ? "data-working-agent"
        : main === "reason"
          ? "data-status-reason-agent"
          : null;
  if (!attr) return;
  const els = document.querySelectorAll<HTMLElement>(`[${attr}="${agentId}"]`);
  const target = els[els.length - 1];
  if (!target) return;

  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  target.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "center" });

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
    target.setAttribute("data-timeline-jump-focus", "true");
    target.focus({ preventScroll: true });
    target.addEventListener(
      "blur",
      () => {
        target.removeAttribute("data-timeline-jump-focus");
        if (!hadTabIndex) target.removeAttribute("tabindex");
      },
      { once: true },
    );
  }
}
