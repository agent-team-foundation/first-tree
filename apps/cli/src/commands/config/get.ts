import { join } from "node:path";
import { clientConfigSchema, DEFAULT_CONFIG_DIR, getConfigValue } from "@first-tree/shared/config";
import type { Command } from "commander";
import { print } from "../../core/output.js";
import { isSecretField } from "./_shared/format.js";

export function registerConfigGetCommand(config: Command): void {
  const clientSchema = clientConfigSchema as Record<string, unknown>;
  // `get` exists alongside `show` for scripts that previously called
  // `first-tree-hub config get <key>` — same semantics as `show <key>`.
  config
    .command("get <key>")
    .description("Get a value from client.yaml (alias for `show <key>`)")
    .option("--show-secrets", "Show secret values in plaintext")
    .action((key: string, flags: { showSecrets?: boolean }) => {
      const path = join(DEFAULT_CONFIG_DIR, "client.yaml");
      const value = getConfigValue(path, key);
      if (value === undefined) {
        print.line(`  ${key}: (not set)\n`);
        return;
      }
      const isSecret = isSecretField(clientSchema, key) && !flags.showSecrets;
      const display = isSecret ? "***" : String(value);
      print.line(`  ${key}: ${display}\n`);
    });
}
