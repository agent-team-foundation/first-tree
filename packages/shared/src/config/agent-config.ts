import { z } from "zod";
import { defineConfig, field } from "./schema.js";
import type { InferConfig } from "./types.js";

/**
 * Agent config layout on disk: `~/.first-tree/hub/config/agents/<name>/agent.yaml`.
 *
 * After the unified-user-token milestone the local config no longer stores an
 * agent bearer; authentication comes from the user's member JWT in
 * `credentials.json`. The config just pins the agent UUID and its runtime so
 * the runtime knows which agent to act as (via `X-Agent-Id`) and which
 * handler to instantiate.
 */
export const agentConfigSchema = defineConfig({
  /** Agent UUID on the Hub (`agents.uuid`). Sent as `X-Agent-Id` header. */
  agentId: field(z.string().min(1)),
  /** Runtime handler type (e.g. "claude-code"). NOT the agent business type. */
  runtime: field(z.string().default("claude-code")),
  concurrency: field(z.number().int().positive().default(5)),
  session: {
    idle_timeout: field(z.number().int().positive().default(300)),
    max_sessions: field(z.number().int().positive().default(10)),
    // Upper bound on how long a session may stay `working`/`blocked` past
    // `idle_timeout` before the runtime force-suspends it. Protects long
    // thinking / large message generation from idle eviction while still
    // bounding stuck-state slot leaks. See evictIdle in session-manager.ts.
    working_grace_seconds: field(z.number().int().positive().default(3600)),
  },
});

export type AgentConfig = InferConfig<typeof agentConfigSchema>;
