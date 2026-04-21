/**
 * `first-tree gardener run-once` — execute both sweeps inline and
 * exit. Handy for exercising the daemon pipeline without starting a
 * background process, and for cron-style deployments that prefer
 * external scheduling.
 */

import { runOnce } from "../daemon/loop.js";

export const RUN_ONCE_USAGE = `usage: first-tree gardener run-once

Run both gardener sweeps exactly once (gardener-sweep, sync-sweep) and
exit. Reads the same ~/.gardener/config.json the daemon would. Updates
state.json with the outcome so \`gardener status\` reflects the run.
`;

export interface RunRunOnceOptions {
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

export async function runRunOnce(
  argv: readonly string[] = [],
  options: RunRunOnceOptions = {},
): Promise<number> {
  const write = options.write ?? ((line) => process.stdout.write(line + "\n"));
  if (argv.includes("--help") || argv.includes("-h")) {
    write(RUN_ONCE_USAGE);
    return 0;
  }
  const results = await runOnce({ env: options.env, write });
  const failed = Object.values(results).some((r) => r?.outcome === "failed");
  return failed ? 1 : 0;
}
