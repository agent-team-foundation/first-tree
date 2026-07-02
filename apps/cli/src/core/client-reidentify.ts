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
 * still emit this code. The CLI treats both as local-client account switching:
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
  const loginCommand = `${channelConfig.binName} login <token>`;
  if (opts.managed && opts.output?.status) {
    output.status?.(
      "✗",
      `client identity is not accepted for this account (${err.message}); run \`${loginCommand}\` with the intended account's connect token to switch local clients. If local identity state is damaged, back it up and run \`${channelConfig.binName} computer reset\`.`,
    );
    process.exit(1);
  }
  output.blank();
  output.line("  ⚠️  This machine's client identity is not accepted for this account.\n");
  output.line(`     Server message: ${err.message}\n`);
  output.blank();
  output.line(`  To switch accounts, run \`${loginCommand}\` with the intended account's connect token.\n`);
  output.line("  The login command will ask for confirmation, stop and drain the current daemon,\n");
  output.line("  park the current local client state, and activate a client for the new user.\n\n");
  output.line(
    `  If local identity state is damaged or unknown, back up local workspaces and run \`${channelConfig.binName} computer reset\`.\n\n`,
  );
  process.exit(1);
}
