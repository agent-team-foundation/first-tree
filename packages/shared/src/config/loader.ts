import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildZodSchema } from "./resolver.js";
import type { InferConfig } from "./types.js";

/**
 * Scan an agents directory and load each agent's config.
 *
 * Expected structure:
 *   {agentsDir}/
 *     code-reviewer/agent.yaml
 *     scheduler/agent.yaml
 *
 * Returns a Map keyed by directory name (agent name).
 */
export function loadAgents<T extends Record<string, unknown>>(options: {
  schema: T;
  agentsDir: string;
}): Map<string, InferConfig<T>> {
  const { schema, agentsDir } = options;
  const result = new Map<string, InferConfig<T>>();

  if (!existsSync(agentsDir)) return result;

  const zodSchema = buildZodSchema(schema as Record<string, unknown>);

  for (const entry of readdirSync(agentsDir)) {
    const agentDir = join(agentsDir, entry);
    if (!statSync(agentDir).isDirectory()) continue;

    const configPath = join(agentDir, "agent.yaml");
    if (!existsSync(configPath)) continue;

    const raw: unknown = parseYaml(readFileSync(configPath, "utf-8"));
    const parsed = zodSchema.parse(raw);
    result.set(entry, parsed as InferConfig<T>);
  }

  return result;
}
