import { join } from "node:path";
import { clientConfigSchema, DEFAULT_CONFIG_DIR, getConfigValue, readConfigFile } from "@first-tree/shared/config";
import type { Command } from "commander";
import { print } from "../../core/output.js";
import { isSecretField, printFlat } from "./_shared/format.js";

export function registerConfigShowCommand(config: Command): void {
  const clientSchema = clientConfigSchema as Record<string, unknown>;
  const clientYamlPath = (): string => join(DEFAULT_CONFIG_DIR, "client.yaml");

  config
    .command("show [key]")
    .description("Show client.yaml — print all values, or a single key with dot-notation")
    .option("--show-secrets", "Show secret values in plaintext")
    .action((key: string | undefined, flags: { showSecrets?: boolean }) => {
      const path = clientYamlPath();
      if (key) {
        const value = getConfigValue(path, key);
        if (value === undefined) {
          print.line(`  ${key}: (not set)\n`);
          return;
        }
        const isSecret = isSecretField(clientSchema, key) && !flags.showSecrets;
        const display = isSecret ? "***" : String(value);
        print.line(`  ${key}: ${display}\n`);
        return;
      }
      const values = readConfigFile(path);
      if (Object.keys(values).length === 0) {
        print.line(`  No config found at ${path}\n`);
        return;
      }
      print.line(`\n  Config: ${path}\n\n`);
      printFlat(values, clientSchema, "", flags.showSecrets ?? false);
      print.line("\n");
    });
}
