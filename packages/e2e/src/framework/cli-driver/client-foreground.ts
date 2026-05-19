import type { RunIdentity } from "../isolation.js";
import type { ComponentLogger } from "../logging.js";
import { type SpawnedCli, spawnCli } from "./exec.js";

/**
 * Thin wrapper over `spawnCli` for the specific case of spawning the long-
 * running `client start --foreground --no-interactive` entry point. The
 * `RunWorld` lifecycle and the dev-user seed both want this exact shape
 * (per-run home, run-scoped log component, optional fake-runtime executable
 * env), so it earns one named helper instead of duplicating the args /
 * env wiring twice.
 *
 * Anything else the dist CLI exposes (one-shot subcommands like `chat send`,
 * `agent list`) goes through `execCli` directly.
 */
export type ClientProcess = SpawnedCli;

export type ClientSpawnOptions = {
  identity: RunIdentity;
  serverBaseUrl: string;
  logger: ComponentLogger;
  /** Fake claude-code binary for the agent-mock e2e path. */
  claudeCodeExecutable?: string;
  /** Extra env overrides (adapters / providers). */
  extraEnv?: NodeJS.ProcessEnv;
};

export function spawnClient(opts: ClientSpawnOptions): Promise<ClientProcess> {
  return spawnCli({
    home: opts.identity.home,
    serverBaseUrl: opts.serverBaseUrl,
    args: ["client", "start", "--foreground", "--no-interactive"],
    logger: opts.logger,
    extraEnv: {
      ...(opts.claudeCodeExecutable ? { CLAUDE_CODE_EXECUTABLE: opts.claudeCodeExecutable } : {}),
      ...opts.extraEnv,
    },
  });
}
