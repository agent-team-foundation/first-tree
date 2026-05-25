import { join } from "node:path";
import { defaultConfigDir, setConfigValue } from "@first-tree/shared/config";
import type { Command } from "commander";
import { print } from "../../core/output.js";

export function registerConfigSetCommand(config: Command): void {
  config
    .command("set <key> <value>")
    .description("Set a value in client.yaml (dot-notation)")
    .action((key: string, value: string) => {
      let parsed: unknown = value;
      if (value === "true") parsed = true;
      else if (value === "false") parsed = false;
      else if (/^\d+$/.test(value)) parsed = Number(value);
      const path = join(defaultConfigDir(), "client.yaml");
      setConfigValue(path, key, parsed);
      print.line(`  Set ${key} in ${path}\n`);
    });
}
