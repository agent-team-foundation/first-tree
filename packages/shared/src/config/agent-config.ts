import { z } from "zod";
import { defineConfig, field } from "./schema.js";
import type { InferConfig } from "./types.js";

export const agentConfigSchema = defineConfig({
  token: field(z.string(), { secret: true }),
  /** Runtime handler type (e.g. "claude-code"). NOT the agent business type. */
  runtime: field(z.string().default("claude-code")),
  concurrency: field(z.number().int().positive().default(5)),
  session: {
    idle_timeout: field(z.number().int().positive().default(300)),
    max_sessions: field(z.number().int().positive().default(10)),
  },
});

export type AgentConfig = InferConfig<typeof agentConfigSchema>;
