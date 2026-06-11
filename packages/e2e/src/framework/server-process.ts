import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { REPO_ROOT } from "./env.js";
import type { RunIdentity } from "./isolation.js";
import type { ComponentLogger } from "./logging.js";
import { waitForHttp } from "./readiness.js";

const SERVER_ENTRY = resolve(REPO_ROOT, "packages/server/dist/index.mjs");

export type ServerProcess = {
  port: number;
  baseUrl: string;
  pid: number;
  stop: () => Promise<void>;
};

export type ServerSpawnOptions = {
  identity: RunIdentity;
  port: number;
  databaseUrl: string;
  logger: ComponentLogger;
  /** Optional extra env overrides; merged on top of the framework's baseline. */
  extraEnv?: NodeJS.ProcessEnv;
  /** Healthz wait budget. Default 30s. */
  readyTimeoutMs?: number;
  /**
   * Optional pre-generated JWT secret. When omitted a fresh one is minted —
   * but in that case nothing else can sign tokens that the server will
   * accept. Provide a value when the framework needs to mint tokens itself
   * (e.g. the credentials helper).
   */
  jwtSecret?: string;
};

export async function spawnServer(opts: ServerSpawnOptions): Promise<ServerProcess> {
  const baseUrl = `http://127.0.0.1:${opts.port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    FIRST_TREE_DATABASE_URL: opts.databaseUrl,
    FIRST_TREE_PORT: String(opts.port),
    FIRST_TREE_HOST: "127.0.0.1",
    FIRST_TREE_JWT_SECRET: opts.jwtSecret ?? randomBytes(32).toString("base64url"),
    FIRST_TREE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    FIRST_TREE_WORKSPACES_ROOT: resolve(opts.identity.home, "workspaces"),
    ...opts.extraEnv,
  };

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO_ROOT,
  });

  child.stdout?.on("data", (c) => opts.logger.pipe(c));
  child.stderr?.on("data", (c) => opts.logger.pipe(c));

  const probeController = new AbortController();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    await Promise.race([
      waitForHttp(`${baseUrl}/healthz`, {
        timeoutMs: opts.readyTimeoutMs ?? 30_000,
        intervalMs: 250,
        consecutive: 3,
        signal: probeController.signal,
      }),
      exited.then(({ code, signal }) => {
        throw new Error(`server exited before readiness (code=${code}, signal=${signal})`);
      }),
    ]);
  } catch (err) {
    probeController.abort();
    await killChild(child);
    throw err;
  } finally {
    // Stop the readiness loop on success too — the race winner left its loser
    // running, and we don't want a stray `fetch` outliving lifecycle teardown.
    probeController.abort();
  }

  return {
    port: opts.port,
    baseUrl,
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
