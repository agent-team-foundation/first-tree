import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CONCURRENCY, IDLE_TIMEOUT_MS, MAX_SESSIONS } from "./constants.js";

/**
 * Minimal `agent.yaml` schema.
 *
 * Unified-user-token milestone: the yaml no longer stores an agent bearer.
 * Runtime authentication comes from the user's JWT in `credentials.json`;
 * the per-agent file just carries the pinned `agentId` and its runtime type.
 */

const legacySessionConfigShape = z
  .object({
    idle_timeout: z.number().int().positive().optional(),
    max_sessions: z.number().int().positive().optional(),
  })
  .passthrough();

const sessionConfigSchema = z
  .object({
    idle_timeout: z
      .number()
      .int()
      .positive()
      .default(IDLE_TIMEOUT_MS / 1000),
    max_sessions: z.number().int().positive().default(MAX_SESSIONS),
    /** How often the client reconciles its local chatIds with the server. */
    reconcile_interval_seconds: z.number().int().min(30).max(3600).default(300),
  })
  .passthrough();

const agentSlotConfigSchema = z
  .object({
    agentId: z.string().min(1),
    type: z.string().min(1),
    session: sessionConfigSchema.prefault({}),
    concurrency: z.number().int().positive().default(CONCURRENCY),
  })
  .passthrough();

const warnedAgents = new Set<string>();
function warnLegacyFields(agentName: string, raw: unknown): void {
  if (warnedAgents.has(agentName) || typeof raw !== "object" || raw === null) return;
  const r = raw as Record<string, unknown>;
  const legacy: string[] = [];
  if ("token" in r) legacy.push("token (removed — authenticate via `first-tree-hub connect <token>`)");
  if ("concurrency" in r) legacy.push("concurrency");
  if (r.session) {
    const parsed = legacySessionConfigShape.safeParse(r.session);
    if (parsed.success) {
      if ("idle_timeout" in parsed.data) legacy.push("session.idle_timeout");
      if ("max_sessions" in parsed.data) legacy.push("session.max_sessions");
    }
  }
  if (legacy.length === 0) return;
  process.stderr.write(
    `[agent.yaml/${agentName}] WARN: ${legacy.join(", ")} are deprecated or removed. Update your config.\n`,
  );
  warnedAgents.add(agentName);
}

const runtimeConfigSchema = z.object({
  server: z.url().default("http://localhost:8000"),
  agents: z
    .record(z.string(), agentSlotConfigSchema)
    .refine((agents) => Object.keys(agents).length > 0, "At least one agent must be defined"),
});

export type SessionConfig = z.infer<typeof sessionConfigSchema>;
export type AgentSlotYamlConfig = z.infer<typeof agentSlotConfigSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

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

export function loadRuntimeConfig(configPath: string): RuntimeConfig {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw) as unknown;
  const expanded = deepExpandEnv(parsed);
  if (typeof expanded === "object" && expanded !== null && "agents" in expanded) {
    const agentsObj = (expanded as { agents?: Record<string, unknown> }).agents;
    if (agentsObj) {
      for (const [name, slot] of Object.entries(agentsObj)) {
        warnLegacyFields(name, slot);
      }
    }
  }
  return runtimeConfigSchema.parse(expanded);
}
