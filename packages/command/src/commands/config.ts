import { join } from "node:path";
import {
  agentConfigSchema,
  clientConfigSchema,
  DEFAULT_CONFIG_DIR,
  getConfigValue,
  readConfigFile,
  serverConfigSchema,
  setConfigValue,
} from "@agent-hub/shared/config";
import type { Command } from "commander";
import { promptMissingFields } from "../server/prompt.js";

type ScopeFlags = {
  server?: boolean;
  client?: boolean;
  agent?: string;
};

function resolveConfigPath(flags: ScopeFlags): { path: string; schema: Record<string, unknown> } {
  if (flags.agent) {
    return {
      path: join(DEFAULT_CONFIG_DIR, "agents", flags.agent, "agent.yaml"),
      schema: agentConfigSchema as Record<string, unknown>,
    };
  }
  if (flags.client) {
    return {
      path: join(DEFAULT_CONFIG_DIR, "client.yaml"),
      schema: clientConfigSchema as Record<string, unknown>,
    };
  }
  // Default to server
  return {
    path: join(DEFAULT_CONFIG_DIR, "server.yaml"),
    schema: serverConfigSchema as Record<string, unknown>,
  };
}

function addScopeOptions(cmd: Command): Command {
  return cmd
    .option("-s, --server", "Server config scope (default)")
    .option("-c, --client", "Client config scope")
    .option("-a, --agent <name>", "Agent config scope");
}

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("Configuration management");

  // Interactive setup wizard
  config
    .command("setup")
    .description("Interactive configuration wizard")
    .option("-s, --server", "Configure server (default)")
    .option("-c, --client", "Configure client")
    .action(async (flags: { server?: boolean; client?: boolean }) => {
      try {
        const schema = flags.client
          ? (clientConfigSchema as Record<string, unknown>)
          : (serverConfigSchema as Record<string, unknown>);
        const role = flags.client ? "client" : "server";
        await promptMissingFields({ schema, role });
        process.stderr.write("\n  Configuration saved.\n");
      } catch (error) {
        if ((error as { name?: string }).name === "ExitPromptError") {
          process.stderr.write("\n  Cancelled.\n");
          return;
        }
        throw error;
      }
    });

  addScopeOptions(config.command("set").description("Set a config value"))
    .argument("<key>", "Config key (dot notation, e.g. database.url)")
    .argument("<value>", "Config value")
    .action((key: string, value: string, flags: ScopeFlags) => {
      const { path } = resolveConfigPath(flags);
      // Try to parse as number or boolean
      let parsed: unknown = value;
      if (value === "true") parsed = true;
      else if (value === "false") parsed = false;
      else if (/^\d+$/.test(value)) parsed = Number(value);

      setConfigValue(path, key, parsed);
      process.stderr.write(`  Set ${key} in ${path}\n`);
    });

  addScopeOptions(config.command("get").description("Get a config value"))
    .argument("<key>", "Config key (dot notation)")
    .option("--show-secrets", "Show secret values in plaintext")
    .action((key: string, flags: ScopeFlags & { showSecrets?: boolean }) => {
      const { path, schema } = resolveConfigPath(flags);
      const value = getConfigValue(path, key);
      if (value === undefined) {
        process.stderr.write(`  ${key}: (not set)\n`);
      } else {
        const isSecret = isSecretField(schema, key) && !flags.showSecrets;
        const display = isSecret ? "***" : String(value);
        process.stderr.write(`  ${key}: ${display}\n`);
      }
    });

  addScopeOptions(config.command("list").description("List all config values"))
    .option("--show-secrets", "Show secret values in plaintext")
    .action((flags: ScopeFlags & { showSecrets?: boolean }) => {
      const { path, schema } = resolveConfigPath(flags);
      const values = readConfigFile(path);
      if (Object.keys(values).length === 0) {
        process.stderr.write(`  No config found at ${path}\n`);
        return;
      }
      process.stderr.write(`\n  Config: ${path}\n\n`);
      printFlat(values, schema, "", flags.showSecrets ?? false);
      process.stderr.write("\n");
    });
}

function printFlat(
  obj: Record<string, unknown>,
  schema: Record<string, unknown>,
  prefix: string,
  showSecrets: boolean,
): void {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      printFlat(value as Record<string, unknown>, schema, fullKey, showSecrets);
    } else {
      const secret = isSecretField(schema, fullKey) && !showSecrets;
      const display = secret ? "***" : String(value);
      process.stderr.write(`  ${fullKey.padEnd(30)} ${display}\n`);
    }
  }
}

/** Check if a dot-path corresponds to a secret field in the schema. */
function isSecretField(schema: Record<string, unknown>, dotPath: string): boolean {
  const parts = dotPath.split(".");
  let current: unknown = schema;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return false;
    const obj = current as Record<string, unknown>;

    // Navigate through optional groups
    if (obj._tag === "optional") {
      current = (obj.shape as Record<string, unknown>)[part];
    } else if (obj._tag === "field") {
      return false;
    } else {
      current = obj[part];
    }
  }

  if (typeof current === "object" && current !== null && "_tag" in current) {
    const field = current as { _tag: string; options?: { secret?: boolean } };
    if (field._tag === "field") {
      return field.options?.secret ?? false;
    }
  }
  return false;
}
