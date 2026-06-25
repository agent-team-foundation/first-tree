import { readFileSync } from "node:fs";
import {
  DEFAULT_AGENT_CONCURRENCY,
  DEFAULT_AGENT_MAX_SESSIONS,
  DEFAULT_WORKING_GRACE_SECONDS,
} from "@first-tree/shared/config";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Legacy `agent.yaml` runtime config for the standalone `AgentRuntime`
 * entry point.
 *
 * The shipped CLI (`apps/cli`) does NOT use this loader — it boots through
 * `ClientRuntime` which reads `agentConfigSchema` from
 * `@first-tree/shared/config`. Session-related defaults below MUST stay in
 * lock-step with that schema so the two boot paths behave identically. If
 * you find yourself changing a value here, change it in
 * `packages/shared/src/config/agent-config.ts` too (or invert the
 * dependency to a shared constants module).
 */

const sessionConfigSchema = z
  .object({
    idle_timeout: z.number().int().positive().default(300),
    max_sessions: z.number().int().positive().default(DEFAULT_AGENT_MAX_SESSIONS),
    /**
     * Upper bound on how long `working` / `blocked` may keep a session
     * alive past `idle_timeout` before force-suspend. See `evictIdle` in
     * `session-manager.ts`. Default kept in lock-step with
     * `@first-tree/shared` `DEFAULT_WORKING_GRACE_SECONDS` (12h).
     */
    working_grace_seconds: z.number().int().positive().default(DEFAULT_WORKING_GRACE_SECONDS),
    /**
     * Defer idle-suspend (and deprioritize concurrency eviction) for a session
     * whose provider still has a live background subprocess, up to the
     * `idle_timeout + working_grace_seconds` hard cap. Optional here (the
     * authoritative default lives in `@first-tree/shared` `agentConfigSchema`);
     * unset is treated as enabled by `agent-slot`.
     */
    defer_suspend_on_subprocess: z.boolean().optional(),
    /** How often the client reconciles its local chatIds with the server. */
    reconcile_interval_seconds: z.number().int().min(30).max(3600).default(300),
  })
  .passthrough();

const agentSlotConfigSchema = z
  .object({
    agentId: z.string().min(1),
    type: z.string().min(1),
    session: sessionConfigSchema.prefault({}),
    concurrency: z.number().int().positive().default(DEFAULT_AGENT_CONCURRENCY),
  })
  .passthrough();

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
  return runtimeConfigSchema.parse(expanded);
}
