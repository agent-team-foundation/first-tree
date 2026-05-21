import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "@first-tree/shared/config";
import type { Command } from "commander";
import { getClientServiceStatus, isServiceSupported, stopClientService } from "../core/index.js";
import { print } from "../core/output.js";

/**
 * `first-tree-hub logout` — symmetric counterpart to `login`. Stops the
 * background daemon and removes persisted credentials. `client.yaml` is
 * kept by default (it carries harmless config like `server.url` and the
 * stable `client.id`); `--purge` opts in to wiping that too.
 */
export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Disconnect from the Hub — stop daemon and clear credentials (symmetric to `login`)")
    .option("--purge", "Also remove client.yaml (server.url etc.); default keeps it")
    .action((options: { purge?: boolean }) => {
      // 1. Stop daemon (best-effort).
      if (isServiceSupported()) {
        const svc = getClientServiceStatus();
        if (svc.state === "active") {
          const res = stopClientService();
          print.line(`  ✓ Stopped ${svc.platform} service${res.ok ? "" : ` (warning: ${res.reason})`}\n`);
        }
      }
      // 2. Remove credentials.
      const credsPath = join(DEFAULT_CONFIG_DIR, "credentials.json");
      if (existsSync(credsPath)) {
        unlinkSync(credsPath);
        print.line(`  ✓ Removed credentials\n`);
      }
      // 3. --purge: also remove client.yaml.
      if (options.purge) {
        const yamlPath = join(DEFAULT_CONFIG_DIR, "client.yaml");
        if (existsSync(yamlPath)) {
          unlinkSync(yamlPath);
          print.line(`  ✓ Removed client.yaml\n`);
        }
      }
      print.line(`\n  Logged out. Run \`first-tree-hub login <token>\` to reconnect.\n\n`);
    });
}
