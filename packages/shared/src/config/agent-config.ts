import { z } from "zod";
import { defineConfig, field } from "./schema.js";
import type { InferConfig } from "./types.js";

/**
 * Agent config layout on disk: `$FIRST_TREE_HOME/config/agents/<name>/agent.yaml`.
 *
 * After the unified-user-token milestone the local config no longer stores an
 * agent bearer; authentication comes from the user's member JWT in
 * `credentials.json`. The config just pins the agent UUID and its runtime so
 * the runtime knows which agent to act as (via `X-Agent-Id`) and which
 * handler to instantiate.
 */
export const agentConfigSchema = defineConfig({
  /** Agent UUID on the server (`agents.uuid`). Sent as `X-Agent-Id` header. */
  agentId: field(z.string().min(1)),
  /** Runtime handler type (e.g. "claude-code"). NOT the agent business type. */
  runtime: field(z.string().default("claude-code")),
  // Effectively-unbounded defaults (#973): hitting either limit interrupts
  // or queues real work, so the limits exist as resource guardrails an
  // operator opts INTO by lowering them — not as everyday scheduling. The
  // idle reaper (`idle_timeout`, 300 s) is what actually bounds steady-state
  // active provider processes; `concurrency` only caps simultaneous
  // overlapping turns. When a limit IS hit, the runtime emits an explicit
  // `resilience.session.*` event instead of limiting silently.
  concurrency: field(z.number().int().positive().default(99)),
  session: {
    idle_timeout: field(z.number().int().positive().default(300)),
    max_sessions: field(z.number().int().positive().default(99)),
    // Upper bound on how long a session may stay `working`/`blocked` past
    // `idle_timeout` before the runtime force-suspends it. Protects long
    // thinking / large message generation from idle eviction while still
    // bounding stuck-state slot leaks: at `idle_timeout + working_grace_seconds`
    // past the last activity the session is reclaimed (see evictIdle in
    // session-manager.ts and #418).
    working_grace_seconds: field(z.number().int().positive().default(3600)),
  },
});

export type AgentConfig = InferConfig<typeof agentConfigSchema>;
