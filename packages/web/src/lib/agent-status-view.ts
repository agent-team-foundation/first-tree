import type { AgentChatStatus, AgentMainStatus, SessionState } from "@first-tree/shared";

/**
 * Upsert one agent's composite status into a cached `AgentChatStatus[]`,
 * returning a new array (or `prev` unchanged when there is nothing to do).
 * Used by the admin-WS delta patch to apply a server-pushed status in place
 * instead of refetching. Pure.
 */
export function upsertAgentStatus(prev: AgentChatStatus[], status: AgentChatStatus): AgentChatStatus[] {
  const idx = prev.findIndex((s) => s.agentId === status.agentId);
  if (idx === -1) return [...prev, status];
  const next = prev.slice();
  next[idx] = status;
  return next;
}

/**
 * Map a per-(agent,chat) `session.state` (the C vocabulary:
 * active/suspended/errored/evicted, or none/null) to a composite
 * `AgentMainStatus` for display. This is what fixes F3: the session context
 * panel previously fed C values to `StateChip` (which only understands the
 * runtime-A vocabulary), collapsing every live session to "Offline".
 *
 * `active → ready` (NOT working): an active session means "engaged in this
 * chat", not "working right now". `working` is driven by live activity (D),
 * which this mapping doesn't see — mirrors `deriveMainStatus(engagement=
 * active)` → ready, per design §7.3B.
 *
 * The param is narrowed to the real session vocabulary (plus none/null) so an
 * unknown string can't be silently accepted at a call site.
 */
export function sessionStateToMain(state: SessionState | "none" | null | undefined): AgentMainStatus {
  switch (state) {
    case "active":
      return "ready";
    case "suspended":
      return "paused";
    case "errored":
      return "failed";
    case "evicted":
      return "offline";
    default:
      // "none" / null / undefined → reachable, nothing pending.
      return "ready";
  }
}

/**
 * Indicator shape. Mirrors the existing StateDot shape+color double-encoding
 * (shape carries meaning too, so color-blind users can still distinguish the
 * non-dot states): `dot` solid circle, `pause` double-bar glyph, `hollow`
 * outline ring.
 */
export type AgentStatusShape = "dot" | "pause" | "hollow";

/** Pulse kind for the indicator; null = static. */
export type AgentStatusPulse = "working" | null;

export type AgentStatusView = {
  /** CSS custom-property reference for the indicator color. */
  colorVar: string;
  /** Indicator shape. */
  shape: AgentStatusShape;
  /** Pulse kind, or null when static. */
  pulse: AgentStatusPulse;
  /** index.css animation class to apply, or null when static. */
  animationClass: string | null;
  /** Sentence-case, user-facing label. */
  label: string;
};

/**
 * Single source of truth mapping a composite `AgentMainStatus` to its visual
 * treatment, per the §9.1 visual vocabulary of the agent-status-ui design.
 * Pure and side-effect-free.
 *
 * Colors are the shared `--state-*` tokens (working = green/alive, idle = blue,
 * blocked = orange, etc.) so this composite vocabulary and
 * the runtime-A StateDot render with one palette; shapes follow StateDot's
 * shape+color double-encoding. This is the
 * *composite* mapping — it does NOT replace StateChip/StateDot, which keep
 * rendering the agent-global runtime vocabulary for the management pages.
 */
export function viewOf(main: AgentMainStatus): AgentStatusView {
  switch (main) {
    case "working":
      return {
        colorVar: "var(--state-working)",
        shape: "dot",
        pulse: "working",
        animationClass: "agent-status-pulse--working",
        label: "Working",
      };
    case "failed":
      // A red solid dot (not a triangle): the corner triangle read sharp /
      // aliased at the small avatar-corner size. Red + the "Failed" reason
      // line carry the meaning; unified with the other dots for a clean column.
      return {
        colorVar: "var(--state-error)",
        shape: "dot",
        pulse: null,
        animationClass: null,
        label: "Failed",
      };
    case "paused":
      return {
        colorVar: "var(--fg-4)",
        shape: "pause",
        pulse: null,
        animationClass: null,
        label: "Paused",
      };
    case "ready":
      // Internal enum stays `ready`; the user-facing word is "Idle" (matches
      // the runtime-A `idle` label and reads clearer than "ready for what?").
      return {
        colorVar: "var(--state-idle)",
        shape: "dot",
        pulse: null,
        animationClass: null,
        label: "Idle",
      };
    case "offline":
      return {
        colorVar: "var(--state-offline)",
        shape: "hollow",
        pulse: null,
        animationClass: null,
        label: "Offline",
      };
  }
}
