import type { ClientOrgMismatchError } from "@first-tree/client";
import { channelConfig } from "./channel.js";
import { print } from "./output.js";

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
