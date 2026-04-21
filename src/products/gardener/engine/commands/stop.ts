/**
 * `first-tree gardener stop` — tear down the gardener daemon. On
 * macOS this `launchctl bootout`s the plist and removes it. Elsewhere
 * we kill the PID recorded in `state.json`.
 */

import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { loadDaemonState, writeDaemonState } from "../daemon/state.js";
import { resolveGardenerDir } from "../daemon/config.js";
import {
  booteLaunchdJob,
  gardenerLaunchdLabel,
  gardenerLaunchdPlistPath,
  supportsLaunchd,
} from "../daemon/launchd.js";

export const STOP_USAGE = `usage: first-tree gardener stop

Tear down the gardener daemon.

- On macOS: \`launchctl bootout\`s the gardener plist + removes it.
- Elsewhere: kills the PID recorded in ~/.gardener/state.json.

Always idempotent: running \`stop\` when nothing is running is a no-op
that exits 0.
`;

export interface RunStopOptions {
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

export async function runStop(
  argv: readonly string[] = [],
  options: RunStopOptions = {},
): Promise<number> {
  const write = options.write ?? ((line) => process.stdout.write(line + "\n"));
  const env = options.env ?? process.env;

  if (argv.includes("--help") || argv.includes("-h")) {
    write(STOP_USAGE);
    return 0;
  }

  const gardenerDir = resolveGardenerDir(env);
  let actedOnLaunchd = false;

  if (supportsLaunchd()) {
    const login = userInfo().username || env.USER || "user";
    const label = gardenerLaunchdLabel(login);
    const plistPath = gardenerLaunchdPlistPath(gardenerDir, label);
    if (existsSync(plistPath)) {
      booteLaunchdJob(label, plistPath);
      write(`gardener daemon stopped via launchd (${label})`);
      actedOnLaunchd = true;
    }
  }

  const state = loadDaemonState(env);
  if (state.pid !== undefined) {
    try {
      process.kill(state.pid, "SIGTERM");
      write(`sent SIGTERM to gardener daemon pid=${state.pid}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        write(
          `failed to signal pid=${state.pid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    writeDaemonState({ ...state, pid: undefined, startedAt: undefined }, env);
  } else if (!actedOnLaunchd) {
    write("gardener daemon: nothing to stop");
  }
  return 0;
}
