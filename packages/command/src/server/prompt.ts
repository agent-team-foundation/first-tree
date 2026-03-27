import { join } from "node:path";
import type { PromptDef } from "@first-tree-core/shared/config";
import { collectMissingPrompts, DEFAULT_CONFIG_DIR, setConfigValue } from "@first-tree-core/shared/config";
import { input, password, select } from "@inquirer/prompts";

/**
 * Check if interactive mode is available.
 * Returns false if --no-interactive flag is set or stdin is not a TTY.
 */
export function isInteractive(noInteractiveFlag?: boolean): boolean {
  if (noInteractiveFlag) return false;
  return process.stdin.isTTY === true;
}

/**
 * Schema-driven interactive setup.
 * Scans the config schema for fields with `prompt` that are missing.
 *
 * In interactive mode: prompts the user and writes results to YAML.
 * In non-interactive mode: fails with a clear error listing missing fields.
 */
export async function promptMissingFields(options: {
  schema: Record<string, unknown>;
  role: string;
  configDir?: string;
  cliArgs?: Record<string, unknown>;
  noInteractive?: boolean;
}): Promise<Record<string, unknown>> {
  const missing = collectMissingPrompts({
    schema: options.schema,
    role: options.role,
    configDir: options.configDir,
    cliArgs: options.cliArgs,
  });
  if (missing.length === 0) return {};

  // Non-interactive: fail with actionable error
  if (!isInteractive(options.noInteractive)) {
    const lines = missing.map((m) => {
      // Find the env var from the field schema
      const envHint = findEnvVar(options.schema, m.dotPath);
      const envStr = envHint ? `  (env: ${envHint})` : "";
      return `  ${m.dotPath}${envStr}`;
    });
    throw new Error(
      `Missing required configuration:\n${lines.join("\n")}\n\n` +
        "Provide values via environment variables, config file (~/.first-tree-core/server.yaml),\n" +
        "or run without --no-interactive to use the interactive setup wizard.",
    );
  }

  // Interactive: prompt for each missing field
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

/** Walk schema to find the env var name for a given dot path. */
function findEnvVar(schema: Record<string, unknown>, dotPath: string): string | undefined {
  const parts = dotPath.split(".");
  let current: unknown = schema;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    const obj = current as Record<string, unknown>;
    if (obj._tag === "optional") {
      current = (obj.shape as Record<string, unknown>)[part];
    } else {
      current = obj[part];
    }
  }
  if (typeof current === "object" && current !== null && "_tag" in current) {
    const field = current as { _tag: string; options?: { env?: string } };
    if (field._tag === "field") return field.options?.env;
  }
  return undefined;
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
