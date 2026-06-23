import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientOrgMismatchError } from "@first-tree/client";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { channelConfig } from "./channel.js";
import { print } from "./output.js";

/**
 * Legacy utility retained for programmatic consumers that already imported it.
 * Current CLI account switching does not call this helper: a different user
 * must run `logout --purge` so local agent runtime state is cleared alongside
 * the old client identity.
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
 * Shared handler for legacy `CLIENT_ORG_MISMATCH` rejections. Current servers
 * reject cross-user reuse as `CLIENT_USER_MISMATCH`, but older deployments may
 * still emit this code. The CLI treats both as purge-first account switching:
 * do not rotate a client id in place, because that would leave old local agent
 * runtime state attached to a new account.
 */
export async function handleClientOrgMismatch(
  err: ClientOrgMismatchError,
  _opts: {
    managed: boolean;
    configDir: string;
    rerunCommand: string;
  },
): Promise<never> {
  const purgeCommand = `${channelConfig.binName} logout --purge`;
  print.blank();
  print.line("  ⚠️  This machine's client identity is not accepted for this account.\n");
  print.line(`     Server message: ${err.message}\n`);
  print.blank();
  print.line(`  To switch accounts, run \`${purgeCommand}\` first, then login again.\n\n`);
  print.line("  `logout --purge` stops the current daemon, signs out the current user, and\n");
  print.line("  removes this machine's local client identity plus local agent configs,\n");
  print.line("  workspaces, and session state. Server-side clients, agents, chats, and\n");
  print.line("  history are not deleted; the previous client and agents simply stop running\n");
  print.line("  from this machine unless they are set up again.\n\n");
  print.line(`  Then run \`${channelConfig.binName} login <token>\` with the intended account's connect token.\n\n`);
  process.exit(1);
}
