import type { AgentMainStatus } from "@first-tree/shared";

/**
 * Map a per-(agent,chat) `session.state` (the C vocabulary:
 * active/suspended/errored/evicted, or none/null) to a composite
 * `AgentMainStatus` for display. Only `session.state` is known at the call
 * site (no live activity / reachability), so `active` shows as `working` per
 * design §7.3B. This is what fixes F3: the session context panel previously
 * fed C values to `StateChip` (which only understands the runtime-A
 * vocabulary), collapsing every live session to "Offline".
 */
export function sessionStateToMain(state: string | null | undefined): AgentMainStatus {
  switch (state) {
    case "active":
      return "working";
    case "suspended":
      return "paused";
    case "errored":
      return "failed";
    case "evicted":
      return "offline";
    default:
      // "none" / null / loading → reachable, nothing pending.
      return "ready";
  }
}

/**
 * Indicator shape. Mirrors the existing StateDot shape+color double-encoding
 * (shape carries meaning too, so color-blind users can still distinguish
 * states): `dot` solid circle, `triangle` warning glyph, `pause` double-bar
 * glyph, `hollow` outline ring.
 */
export type AgentStatusShape = "dot" | "triangle" | "pause" | "hollow";

/** Pulse kind for the indicator; null = static. */
export type AgentStatusPulse = "working" | "needs-you" | null;

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
 * Colors are the shared `--state-*` tokens (working = blue everywhere, etc.)
 * so this composite vocabulary and the runtime-A StateDot render with one
 * palette; shapes follow StateDot's shape+color double-encoding. This is the
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
    case "needs_you":
      return {
        colorVar: "var(--state-blocked)",
        shape: "dot",
        pulse: "needs-you",
        animationClass: "agent-status-pulse--needs-you",
        label: "Needs you",
      };
    case "failed":
      return {
        colorVar: "var(--state-error)",
        shape: "triangle",
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
      return {
        colorVar: "var(--state-idle)",
        shape: "dot",
        pulse: null,
        animationClass: null,
        label: "Ready",
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
