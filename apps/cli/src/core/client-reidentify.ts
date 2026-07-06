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
 * still emit this code. Reaching this handler means the runtime already tried
 * to register the active root client with the current credentials and the
 * server rejected that pairing. Do not tell users to retry the same login in a
 * loop; require local identity repair/reset unless they can return to a known
 * owner state and let `login` switch before daemon startup.
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
  const resetCommand = `${channelConfig.binName} computer reset`;
  if (opts.managed && opts.output?.status) {
    output.status?.(
      "✗",
      `client identity is not accepted for this account (${err.message}); back up local workspaces, run \`${resetCommand}\`, then run \`${loginCommand}\` with the intended account's connect token.`,
    );
    process.exit(1);
  }
  output.blank();
  output.line("  ⚠️  This machine's client identity is not accepted for this account.\n");
  output.line(`     Server message: ${err.message}\n`);
  output.blank();
  output.line("  The active client id and current credentials do not form a valid server-side owner pair.\n");
  output.line(
    `  Back up local workspaces, run \`${resetCommand}\`, then run \`${loginCommand}\` with the intended account's connect token.\n\n`,
  );
  process.exit(1);
}
