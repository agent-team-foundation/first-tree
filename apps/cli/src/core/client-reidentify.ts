import type { ClientOrgMismatchError } from "@first-tree/client";
import { channelConfig } from "./channel.js";
import type { ClientRuntimeOutput } from "./client-runtime.js";
import { print } from "./output.js";

type ClientReidentifyOutput = Pick<ClientRuntimeOutput, "blank" | "line"> &
  Partial<Pick<ClientRuntimeOutput, "status">>;

const printClientReidentifyOutput: ClientReidentifyOutput = {
  blank: () => print.blank(),
  line: (text) => print.line(text),
};

/**
 * Shared handler for legacy `CLIENT_ORG_MISMATCH` rejections. Current servers
 * reject cross-user reuse as `CLIENT_USER_MISMATCH`, but older deployments may
 * still emit this code. The CLI treats both as purge-first account switching:
 * do not rotate a client id in place, because that would leave old local agent
 * runtime state attached to a new account.
 */
export async function handleClientOrgMismatch(
  err: ClientOrgMismatchError,
  opts: {
    managed: boolean;
    configDir: string;
    rerunCommand: string;
    output?: ClientReidentifyOutput;
  },
): Promise<never> {
  const output = opts.output ?? printClientReidentifyOutput;
  const purgeCommand = `${channelConfig.binName} logout --purge`;
  if (opts.managed && opts.output?.status) {
    output.status?.(
      "✗",
      `client identity is not accepted for this account (${err.message}); run \`${purgeCommand}\`, then \`${channelConfig.binName} login <token>\` with the intended account's connect token. Local client identity plus local agent configs, workspaces, and session state stay account-scoped; server-side clients, agents, chats, and history are not deleted.`,
    );
    process.exit(1);
  }
  output.blank();
  output.line("  ⚠️  This machine's client identity is not accepted for this account.\n");
  output.line(`     Server message: ${err.message}\n`);
  output.blank();
  output.line(`  To switch accounts, run \`${purgeCommand}\` first, then login again.\n\n`);
  output.line("  `logout --purge` stops the current daemon, signs out the current user, and\n");
  output.line("  removes this machine's local client identity plus local agent configs,\n");
  output.line("  workspaces, and session state. Server-side clients, agents, chats, and\n");
  output.line("  history are not deleted; the previous client and agents simply stop running\n");
  output.line("  from this machine unless they are set up again.\n\n");
  output.line(`  Then run \`${channelConfig.binName} login <token>\` with the intended account's connect token.\n\n`);
  process.exit(1);
}
