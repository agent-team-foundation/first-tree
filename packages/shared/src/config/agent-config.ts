import { z } from "zod";
import { defineConfig, field } from "./schema.js";
import type { InferConfig } from "./types.js";

export const agentConfigSchema = defineConfig({
  token: field(z.string(), { secret: true }),
  type: field(z.string().default("claude-code")),
  cwd: field(z.string().optional()),
  concurrency: field(z.number().int().positive().default(5)),
  session: {
    idle_timeout: field(z.number().int().positive().default(300)),
    max_sessions: field(z.number().int().positive().default(10)),
  },
});

export type AgentConfig = InferConfig<typeof agentConfigSchema>;
