import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env.js";
import type { RunIdentity } from "./isolation.js";
import type { ComponentLogger } from "./logging.js";

const CLI_ENTRY = resolve(REPO_ROOT, "packages/command/dist/cli/index.mjs");

export type ClientProcess = {
  pid: number;
  stop: () => Promise<void>;
};

export type ClientSpawnOptions = {
  identity: RunIdentity;
  serverBaseUrl: string;
  logger: ComponentLogger;
  /**
   * Optional path to a fake `claude-code` executable. Set during M2 when the
   * agent-mock is wired in (see proposal §六.5). M1 smoke doesn't drive the
   * agent runtime, so leaving this unset is fine.
   */
  claudeCodeExecutable?: string;
  /** Extra env overrides for adapters / providers. */
  extraEnv?: NodeJS.ProcessEnv;
};

/**
 * Spawn the unified CLI in `client start --foreground` mode (see F1 in
 * proposal v4 — the flag already exists on `commands/client.ts:85`, so no
 * client source change is required for M1). FIRST_TREE_HUB_HOME is pointed
 * at the run-scoped temp dir so credentials / sessions / config live entirely
 * outside the developer's prod or dev install.
 *
 * M1 limits the smoke contract to "client process is launched and stays up";
 * proving end-to-end WS handshake is a M2 concern that will land alongside
 * the agent-mock so the client has a real agent to bind.
 */
export async function spawnClient(opts: ClientSpawnOptions): Promise<ClientProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    FIRST_TREE_HUB_HOME: opts.identity.home,
    FIRST_TREE_HUB_SERVER_URL: opts.serverBaseUrl,
    ...(opts.claudeCodeExecutable ? { CLAUDE_CODE_EXECUTABLE: opts.claudeCodeExecutable } : {}),
    ...opts.extraEnv,
  };

  const child = spawn(process.execPath, [CLI_ENTRY, "client", "start", "--foreground", "--no-interactive"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO_ROOT,
  });

  child.stdout?.on("data", (c) => opts.logger.pipe(c));
  child.stderr?.on("data", (c) => opts.logger.pipe(c));

  // Brief grace period so an immediate exit (e.g. missing config) surfaces
  // before the caller assumes the client is up. The full end-to-end "client
  // is bound to server" probe lands in M2 once chat-send / agent-mock are
  // wired and we have a real signal to wait on; for M1 we only need the
  // process to come up and stay up.
  await new Promise<void>((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      reject(new Error(`client exited during startup (code=${code}, signal=${signal})`));
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, 1_500);
    child.once("exit", onExit);
  });

  return {
    pid: child.pid ?? -1,
    stop: () => killChild(child),
  };
}

async function killChild(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const timer = new Promise<void>((resolve) =>
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    }, 5_000),
  );
  await Promise.race([done, timer]);
}
