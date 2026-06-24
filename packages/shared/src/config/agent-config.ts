import { z } from "zod";
import { defineConfig, field } from "./schema.js";
import type { InferConfig } from "./types.js";

export const DEFAULT_AGENT_CONCURRENCY = 99;
export const DEFAULT_AGENT_MAX_SESSIONS = 99;

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
  concurrency: field(z.number().int().positive().default(DEFAULT_AGENT_CONCURRENCY)),
  session: {
    idle_timeout: field(z.number().int().positive().default(300)),
    max_sessions: field(z.number().int().positive().default(DEFAULT_AGENT_MAX_SESSIONS)),
    // Upper bound on how long a session may stay `working`/`blocked` past
    // `idle_timeout` before the runtime force-suspends it. Protects long
    // thinking / large message generation from idle eviction while still
    // bounding stuck-state slot leaks: at `idle_timeout + working_grace_seconds`
    // past the last activity the session is reclaimed (see evictIdle in
    // session-manager.ts and #418).
    working_grace_seconds: field(z.number().int().positive().default(3600)),
    // When a session goes idle but its provider still has a live background
    // subprocess (e.g. a `run_in_background` watcher polling CI), defer
    // idle-suspend and deprioritize concurrency eviction so the subprocess's
    // completion wake-up is not lost — still bounded by the
    // `idle_timeout + working_grace_seconds` hard cap (see evictIdle in
    // client `session-manager.ts`). Default on.
    defer_suspend_on_subprocess: field(z.boolean().default(true)),
  },
});

export type AgentConfig = InferConfig<typeof agentConfigSchema>;
