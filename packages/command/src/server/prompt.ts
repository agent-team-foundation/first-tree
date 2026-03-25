import { join } from "node:path";
import type { PromptDef } from "@agent-hub/shared/config";
import { collectMissingPrompts, DEFAULT_CONFIG_DIR, setConfigValue } from "@agent-hub/shared/config";
import { input, password, select } from "@inquirer/prompts";

/**
 * Schema-driven interactive setup.
 * Scans the config schema for fields with `prompt` that are missing,
 * prompts the user, and writes results to the YAML file.
 */
export async function promptMissingFields(options: {
  schema: Record<string, unknown>;
  role: string;
  configDir?: string;
  cliArgs?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const missing = collectMissingPrompts(options);
  if (missing.length === 0) return {};

  const configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
  const configPath = join(configDir, `${options.role}.yaml`);
  const results: Record<string, unknown> = {};

  for (const { dotPath, prompt } of missing) {
    const value = await askPrompt(dotPath, prompt);
    if (value !== undefined) {
      setConfigValue(configPath, dotPath, value);
      setNestedByDot(results, dotPath, value);
    }
  }

  return results;
}

/**
 * Interactive add agent — simple two-field prompt.
 */
export async function promptAddAgent(): Promise<{ name: string; token: string }> {
  const name = await input({
    message: "Agent name:",
    validate: (v) => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? true : "Lowercase alphanumeric and hyphens only"),
  });
  const token = await input({
    message: "Agent token:",
    validate: (v) => (v.length > 0 ? true : "Token is required"),
  });
  return { name, token };
}

// ── Internal ─────────────────────────────────────────────────────────

async function askPrompt(dotPath: string, prompt: PromptDef): Promise<unknown> {
  const type = prompt.type ?? "input";

  if (type === "select" && prompt.choices) {
    const value = await select({
      message: prompt.message,
      choices: prompt.choices.map((c) => ({ name: c.name, value: c.value })),
    });

    // Special value "__auto__" means "use auto-generation, don't set a value"
    if (value === "__auto__") return undefined;

    // Special value "__input__" means "follow up with a text input"
    if (value === "__input__") {
      return input({
        message: `${dotPath}:`,
        validate: (v) => (v.length > 0 ? true : "Value is required"),
      });
    }

    return value;
  }

  if (type === "password") {
    return password({ message: prompt.message });
  }

  return input({
    message: prompt.message,
    default: prompt.default,
  });
}

function setNestedByDot(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (key === undefined) continue;
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = parts.at(-1);
  if (lastKey !== undefined) {
    current[lastKey] = value;
  }
}
