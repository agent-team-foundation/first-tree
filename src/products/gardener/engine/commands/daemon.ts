/**
 * `first-tree gardener daemon` — foreground loop. Invoked by
 * `gardener start` under launchd (or a detached spawn) and intended
 * to run forever. Humans normally don't call this directly.
 */

import { runDaemonLoop } from "../daemon/loop.js";

export const DAEMON_USAGE = `usage: first-tree gardener daemon

Run the gardener daemon loop in the foreground. Invoked by
\`gardener start\` under launchd (or a detached spawn); not intended
for direct human use. Runs forever unless interrupted. Reads config
from ~/.gardener/config.json on every tick.
`;

export interface RunDaemonOptions {
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

export async function runDaemon(
  argv: readonly string[] = [],
  options: RunDaemonOptions = {},
): Promise<number> {
  const write = options.write ?? ((line) => process.stdout.write(line + "\n"));
  if (argv.includes("--help") || argv.includes("-h")) {
    write(DAEMON_USAGE);
    return 0;
  }
  await runDaemonLoop({ env: options.env, write });
  return 0;
}
