import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

const sessionConfigSchema = z.object({
  idle_timeout: z.number().int().positive().default(300),
  max_sessions: z.number().int().positive().default(10),
});

const agentSlotConfigSchema = z.object({
  token: z.string().min(1),
  type: z.string().min(1),
  session: sessionConfigSchema.default({}),
  concurrency: z.number().int().positive().default(5),
});

const runtimeConfigSchema = z.object({
  server: z.string().url().default("http://localhost:8000"),
  agents: z
    .record(agentSlotConfigSchema)
    .refine((agents) => Object.keys(agents).length > 0, "At least one agent must be defined"),
});

export type SessionConfig = z.infer<typeof sessionConfigSchema>;
export type AgentSlotYamlConfig = z.infer<typeof agentSlotConfigSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

// ---------------------------------------------------------------------------
// Environment variable expansion
// ---------------------------------------------------------------------------

function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const envVal = process.env[name];
    if (envVal === undefined) {
      throw new Error(`Environment variable "${name}" is not set`);
    }
    return envVal;
  });
}

function deepExpandEnv(obj: unknown): unknown {
  if (typeof obj === "string") {
    return expandEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(deepExpandEnv);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = deepExpandEnv(value);
    }
    return result;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export function loadRuntimeConfig(configPath: string): RuntimeConfig {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw) as unknown;
  const expanded = deepExpandEnv(parsed);
  return runtimeConfigSchema.parse(expanded);
}
