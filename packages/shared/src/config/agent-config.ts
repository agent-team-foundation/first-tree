import { z } from "zod";
import { defineConfig, field } from "./schema.js";
import type { InferConfig } from "./types.js";

export const agentConfigSchema = defineConfig({
  token: field(z.string(), { secret: true }),
});

export type AgentConfig = InferConfig<typeof agentConfigSchema>;
