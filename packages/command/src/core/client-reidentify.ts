import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientOrgMismatchError } from "@first-tree-hub/client";
import { createLogger } from "@first-tree-hub/client";
import { confirm } from "@inquirer/prompts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { print } from "./output.js";

/**
 * Handle a `CLIENT_ORG_MISMATCH` from the server by rotating the local
 * `client.id` in `client.yaml`. The server binds every client to one org for
 * its lifetime; when the user's credentials move to a different org, the old
 * clientId becomes unusable and a new one must be issued locally. The old
 * yaml is preserved as `client.yaml.bak` so the operator can recover or
 * audit the previous identity.
 *
 * Returns the generated clientId. The caller is expected to reset the config
 * singleton and re-run its initialization so the new id takes effect.
 */
export function rotateClientIdWithBackup(configDir: string): {
  oldId: string | null;
  newId: string;
  backupPath: string;
  yamlPath: string;
} {
  const yamlPath = join(configDir, "client.yaml");
  const backupPath = join(configDir, "client.yaml.bak");

  if (!existsSync(yamlPath)) {
    throw new Error(`Cannot rotate client id — ${yamlPath} does not exist.`);
  }

  const raw = readFileSync(yamlPath, "utf-8");
  copyFileSync(yamlPath, backupPath);

  const parsed: unknown = parseYaml(raw);
  const current = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const clientSection =
    typeof current.client === "object" && current.client !== null ? (current.client as Record<string, unknown>) : {};
  const oldId = typeof clientSection.id === "string" ? clientSection.id : null;
  const newId = `client_${randomBytes(4).toString("hex")}`;

  const updated = {
    ...current,
    client: { ...clientSection, id: newId },
  };

  writeFileSync(yamlPath, stringifyYaml(updated), { mode: 0o600 });

  return { oldId, newId, backupPath, yamlPath };
}

/**
 * Shared handler for `CLIENT_ORG_MISMATCH` across CLI entry points
 * (`client start` and `client connect --no-service`). Prompts interactively,
 * rotates the local clientId, and always exits the current process — the
 * runtime is already poisoned (wrong clientId in memory), so continuing
 * in-band is not safe. Service-supervised (managed) runs skip the prompt and
 * leave an audit trail in pino so operators can trace `.bak` files later.
 *
 * Exits with:
 *   - 0 after a successful rotate (operator is told how to re-run).
 *   - 1 if the user declines or rotation itself fails.
 */
export async function handleClientOrgMismatch(
  err: ClientOrgMismatchError,
  opts: {
    /** launchd/systemd mode: skip prompt, log for audit. */
    managed: boolean;
    /** Directory holding `client.yaml` (usually `DEFAULT_CONFIG_DIR`). */
    configDir: string;
    /** Exact shell command to show the user for the follow-up run. */
    rerunCommand: string;
  },
): Promise<never> {
  print.blank();
  print.line("  ⚠️  This machine is registered as a client in a different organization.\n");
  print.line(`     Server message: ${err.message}\n`);
  print.blank();

  const confirmed = opts.managed
    ? true
    : await confirm({
        message: "Rotate the local client identity and register fresh?",
        default: true,
      }).catch(() => false);

  if (!confirmed) {
    print.line("  Aborted — no changes made.\n");
    process.exit(1);
  }

  try {
    const { oldId, newId, backupPath } = rotateClientIdWithBackup(opts.configDir);

    // Service (managed) mode runs without a human; the rotation would otherwise
    // be invisible. A warn-level pino entry makes the `.bak` file traceable
    // from the service logs.
    if (opts.managed) {
      createLogger("client").warn(
        { oldId, newId, backupPath },
        "client identity rotated on CLIENT_ORG_MISMATCH (managed mode)",
      );
    }

    print.blank();
    print.line(`  ✓ Rotated local client identity.\n`);
    print.line(`      old clientId: ${oldId ?? "(unset)"}\n`);
    print.line(`      new clientId: ${newId}\n`);
    print.line(`      previous yaml backed up to: ${backupPath}\n`);
    print.blank();
    print.line("  Note: the old client remains in the previous org. That org's admin\n");
    print.line("  can remove it if cleanup is needed.\n");
    print.blank();

    if (opts.managed) {
      print.line("  The background service will pick up the new identity on its next restart.\n\n");
    } else {
      print.line("  To reconnect with the new identity, run:\n\n");
      print.line(`      ${opts.rerunCommand}\n\n`);
    }
    process.exit(0);
  } catch (rotateErr) {
    const rmsg = rotateErr instanceof Error ? rotateErr.message : String(rotateErr);
    print.line(`  Failed to rotate client identity: ${rmsg}\n`);
    process.exit(1);
  }
}
