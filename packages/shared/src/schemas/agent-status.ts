import { z } from "zod";
import { type LiveActivity, liveActivitySchema } from "./me-chat.js";

/**
 * Composite "main" status — the single value a compact surface (a status
 * dot, a one-line chip) shows for an agent *in a specific chat*. It is a
 * lossy projection of the four orthogonal status axes onto one token:
 *
 *   - reachability (A) — is the runtime/client reachable at all
 *   - engagement   (C) — the per-(agent,chat) session lifecycle
 *   - activity     (D) — is the agent producing output right now
 *   - attention        — does a human need to act (failure / pending question)
 *
 * `deriveMainStatus` resolves the projection using `MAIN_STATUS_PRIORITY`.
 *
 * IMPORTANT: this is the *per-(agent,chat) composite* vocabulary. It is
 * deliberately distinct from the agent-global runtime vocabulary
 * (`idle/working/blocked/error/offline`, see `schemas/presence.ts`
 * `RuntimeState`). The two share visual tokens (color / shape) but NOT enum
 * values — surfaces must not feed one where the other is expected (that is
 * the class of bug that left SessionContext rendering every session as
 * "Offline").
 */
export const AGENT_MAIN_STATUSES = {
  OFFLINE: "offline",
  FAILED: "failed",
  NEEDS_YOU: "needs_you",
  WORKING: "working",
  PAUSED: "paused",
  READY: "ready",
} as const;

export const agentMainStatusSchema = z.enum(["offline", "failed", "needs_you", "working", "paused", "ready"]);
export type AgentMainStatus = z.infer<typeof agentMainStatusSchema>;

/**
 * Priority for the lossy projection, highest-attention first. When several
 * axes are simultaneously true, the earliest entry wins the single display
 * slot. Two principles stack:
 *   1. logical gating — an unreachable agent cannot be "working", so
 *      `offline` dominates everything;
 *   2. attention value — among the rest, the more the human needs to act,
 *      the earlier it sorts (failure > pending question > working > paused >
 *      ready).
 *
 * Lower index = higher priority. Also used by surfaces that *rank* agents
 * (e.g. the compose status bar puts the highest-priority agent on top).
 */
export const MAIN_STATUS_PRIORITY = [
  "offline",
  "failed",
  "needs_you",
  "working",
  "paused",
  "ready",
] as const satisfies readonly AgentMainStatus[];

/** Per-(agent,chat) engagement = the agent's session lifecycle in THIS chat. */
export const AGENT_ENGAGEMENTS = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  NONE: "none",
} as const;

export const agentEngagementSchema = z.enum(["active", "suspended", "none"]);
export type AgentEngagement = z.infer<typeof agentEngagementSchema>;

/**
 * Freshness window (ms) for the per-(agent,chat) D-axis runtime state. The
 * client re-affirms `working` / `blocked` / `error` sessions on a ~20s timer
 * (RUNTIME_REAFFIRM_BASE_MS) with ±20% jitter so a long turn keeps
 * `runtime_state_at` fresh; if no re-affirm lands within this window the
 * server stops treating the session as working/errored (self-heals after a
 * silent client death where the `idle` transition was never received).
 * 60s = 3× the nominal re-affirm interval, matching the approved spec
 * (proposals/hub-agent-status-working-freshness.20260525.md §6.1 §10).
 *
 * Direct consequence: when a client process crashes mid-turn the user-visible
 * "stuck-working" upper bound is RUNTIME_STALE_MS.
 */
export const RUNTIME_STALE_MS = 60_000;

/** Inputs to the projection — one field per status axis. */
export type DeriveMainStatusInput = {
  /** Reachability (A): is the agent's runtime/client reachable at all? */
  reachable: boolean;
  /** A concrete failure the user should see (session `errored` OR runtime `error`). */
  errored: boolean;
  /** A pending AskUserQuestion is waiting on a human in this chat. */
  needsYou: boolean;
  /** Activity (D): the agent is producing output right now (live activity present). */
  working: boolean;
  /** Engagement (C): the per-(agent,chat) session lifecycle. */
  engagement: AgentEngagement;
};

/**
 * Reduce the four axes to a single `AgentMainStatus`. Pure and deterministic;
 * the if-ladder is exactly `MAIN_STATUS_PRIORITY` order. Shared by server
 * (authority) and client (so a unit test pins the contract once).
 */
export function deriveMainStatus(input: DeriveMainStatusInput): AgentMainStatus {
  // Gating: nothing else can be true if the agent can't be reached.
  if (!input.reachable) return "offline";
  if (input.errored) return "failed";
  if (input.needsYou) return "needs_you";
  if (input.working) return "working";
  if (input.engagement === "suspended") return "paused";
  return "ready";
}

/**
 * Compare two main statuses by attention priority. Returns < 0 when `a`
 * should sort before `b` (higher attention). Stable input for `Array.sort`.
 */
export function compareMainStatus(a: AgentMainStatus, b: AgentMainStatus): number {
  return MAIN_STATUS_PRIORITY.indexOf(a) - MAIN_STATUS_PRIORITY.indexOf(b);
}

/**
 * Server-derived composite status for one agent in one chat. Produced
 * server-side — the authority, because only the server can aggregate
 * reachability, session, live activity, and pending-question across the
 * data plane — and consumed read-only by every UI surface.
 *
 * INVARIANT: `main === deriveMainStatus(the other fields)`. The schema's
 * `superRefine` enforces it on parse, so a self-contradictory payload (e.g.
 * `{ main: "ready", working: true }`) is rejected rather than silently
 * trusted. Always construct via `buildAgentChatStatus` to keep `main`
 * derived rather than hand-set.
 */
export const agentChatStatusSchema = z
  .object({
    agentId: z.string(),
    main: agentMainStatusSchema,
    reachable: z.boolean(),
    engagement: agentEngagementSchema,
    working: z.boolean(),
    needsYou: z.boolean(),
    errored: z.boolean(),
    /**
     * The live activity driving `working` (tool name / "Thinking" / "Writing"
     * + startedAt), or null when not working. Carried so per-agent surfaces
     * (AgentRow / compose) can render the "Using <tool> · 12s" detail without
     * a second round-trip. Not an input to `main` — purely descriptive.
     */
    activity: liveActivitySchema.nullable(),
  })
  .superRefine((val, ctx) => {
    const expected = deriveMainStatus(val);
    if (val.main !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `main "${val.main}" must equal deriveMainStatus(...) = "${expected}"`,
        path: ["main"],
      });
    }
  });
export type AgentChatStatus = z.infer<typeof agentChatStatusSchema>;

/** Inputs to `buildAgentChatStatus` — the axis fields plus the agent id and
 * the optional descriptive live activity. */
export type AgentChatStatusInput = DeriveMainStatusInput & { agentId: string; activity?: LiveActivity | null };

/**
 * Construct an `AgentChatStatus` with `main` always derived from the axes
 * (never hand-set), keeping the schema invariant true by construction. This
 * is the only sanctioned way to build the composite status server-side.
 */
export function buildAgentChatStatus(input: AgentChatStatusInput): AgentChatStatus {
  return {
    agentId: input.agentId,
    reachable: input.reachable,
    engagement: input.engagement,
    working: input.working,
    needsYou: input.needsYou,
    errored: input.errored,
    main: deriveMainStatus(input),
    activity: input.activity ?? null,
  };
}
