import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  clientConfigSchema,
  DEFAULT_CONFIG_DIR,
  initConfig,
  resetConfig,
  resetConfigMeta,
  setConfigValue,
} from "@agent-team-foundation/first-tree-hub-shared/config";
import { type Command, InvalidArgumentError } from "commander";
import {
  bootstrapServer,
  ClientRuntime,
  COMMAND_VERSION,
  createAdmin,
  createExecuteUpdate,
  hasUser,
  isDockerAvailable,
  promptUpdate,
  saveCredentials,
} from "../core/index.js";
import { blank, print, status } from "../core/output.js";

type StartCommandOptions = {
  port?: number;
  host?: string;
  databaseUrl?: string;
  open?: boolean;
};

const DEFAULT_PORT = 8000;

/**
 * `first-tree-hub start` — foreground shape.
 *
 * Replaces the legacy `server start` + `admin:create` + `client connect`
 * three-step onboarding. The foreground shape blocks until SIGINT; the
 * `--service` shape (Phase 1b / C8) reuses the same install-time helpers.
 */
export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Run First Tree Hub in this terminal (foreground)")
    .option("--port <number>", "Server port (default: 8000)", parsePortArg)
    .option("--host <address>", "Bind address (default: 127.0.0.1)")
    .option("--database-url <url>", "Use an existing PostgreSQL (skip Docker)")
    .option("--no-open", "Do not auto-open the browser")
    .action(async (options: StartCommandOptions) => {
      try {
        await runStart(options);
      } catch (err) {
        if (isAddressInUseError(err)) {
          const port = options.port ?? DEFAULT_PORT;
          print.line(`\n  Port ${port} is busy. Try 'first-tree-hub start --port ${port + 1}'.\n\n`);
          process.exit(1);
        }
        const msg = err instanceof Error ? err.message : String(err);
        print.line(`\n  Error: ${msg}\n\n`);
        process.exit(1);
      }
    });
}

async function runStart(options: StartCommandOptions): Promise<void> {
  print.line(`\n  First Tree Hub v${COMMAND_VERSION}\n\n`);

  // Docker preflight (skipped only when caller supplies --database-url).
  if (options.databaseUrl === undefined && !isDockerAvailable()) {
    throw new Error(
      "Docker is not available.\n\n" +
        "  First Tree Hub needs PostgreSQL. Two options:\n\n" +
        "  1. Install Docker → https://docs.docker.com/get-docker/\n" +
        "     Then re-run: first-tree-hub start\n\n" +
        "  2. Provide an existing PostgreSQL URL:\n" +
        "     first-tree-hub start --database-url postgresql://user:pass@host:5432/db",
    );
  }

  // Pre-probe the port BEFORE any side effects (Postgres, migrations,
  // createAdmin). Otherwise an EADDRINUSE collision discovered at
  // `app.listen()` time leaves a half-installed state behind.
  const requestedPort = options.port ?? DEFAULT_PORT;
  const requestedHost = options.host ?? "127.0.0.1";
  await assertPortFree(requestedHost, requestedPort);

  const { app, config, shutdownTelemetry } = await bootstrapServer({
    port: options.port,
    host: options.host,
    databaseUrl: options.databaseUrl,
    noInteractive: false,
  });

  let listening = false;
  try {
    const adminCreated = await ensureLocalAdmin(config.database.url);
    if (adminCreated) status("Local admin", "ready");

    await app.listen({ host: config.server.host, port: config.server.port });
    listening = true;
    status("Server", `listening at http://${config.server.host}:${config.server.port}`);

    // initConfig auto-generates `client.id` on first run; persist server URL
    // so subsequent CLI invocations resolve it without --server.
    const clientServerUrl = `http://${normaliseHost(config.server.host)}:${config.server.port}`;
    setConfigValue(join(DEFAULT_CONFIG_DIR, "client.yaml"), "server.url", clientServerUrl);
    resetConfig();
    resetConfigMeta();
    const clientConfig = await initConfig({ schema: clientConfigSchema, role: "client" });

    const tokens = await fetchLocalBootstrapTokens(clientServerUrl);
    saveCredentials({ ...tokens, serverUrl: clientServerUrl });
    status("Client", `connected as ${clientConfig.client.id}`);

    const runtime = new ClientRuntime(clientConfig.server.url, clientConfig.client.id, {
      currentVersion: COMMAND_VERSION,
      update: {
        updateConfig: clientConfig.update,
        prompt: promptUpdate,
        executeUpdate: createExecuteUpdate({ managed: false }),
      },
    });
    const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
    await runtime.start();
    runtime.watchAgentsDir(agentsDir);

    const browserUrl = `http://${normaliseHost(config.server.host)}:${config.server.port}`;
    if (shouldAutoOpenBrowser(options)) {
      openBrowser(browserUrl);
      print.line(`\n  Opening browser at ${browserUrl}\n`);
    } else {
      print.line(`\n  Open ${browserUrl} in your browser to get started.\n`);
    }
    blank();
    print.line("  Press Ctrl+C to stop.\n");
    print.line("  (Postgres container keeps running. To also stop it: first-tree-hub server stop)\n\n");

    await blockUntilSignal(runtime, app, shutdownTelemetry);
  } catch (err) {
    // Steps after `bootstrapServer` may fail (e.g. local-bootstrap probe
    // returns 401 because of a misconfigured proxy in dev). Always tear down
    // fastify + telemetry so we don't leak DB connections / spans.
    await safeClose(app, listening, shutdownTelemetry);
    throw err;
  }
}

/**
 * Blocks until SIGINT/SIGTERM, then runs an idempotent shutdown sequence
 * and exits. Each leaf step is independently caught so a single failing
 * step doesn't skip the rest, and a non-zero exit code surfaces to service
 * supervisors (Phase 1b) when any step fails.
 */
function blockUntilSignal(
  runtime: ClientRuntime,
  app: { close: () => Promise<unknown> },
  shutdownTelemetry: () => Promise<void>,
): Promise<never> {
  return new Promise<never>(() => {
    let triggered = false;
    const onSignal = () => {
      if (triggered) return;
      triggered = true;
      void (async () => {
        print.line("\n  Shutting down...\n");
        let exitCode = 0;
        try {
          runtime.unwatchAgentsDir();
        } catch {
          exitCode = 1;
        }
        try {
          await runtime.stop();
        } catch (err) {
          exitCode = 1;
          print.line(`  Warning: client runtime did not stop cleanly: ${describeError(err)}\n`);
        }
        try {
          await app.close();
        } catch (err) {
          exitCode = 1;
          print.line(`  Warning: server did not close cleanly: ${describeError(err)}\n`);
        }
        try {
          await shutdownTelemetry();
        } catch {
          exitCode = 1;
        }
        process.exit(exitCode);
      })();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeClose(
  app: { close: () => Promise<unknown> },
  listening: boolean,
  shutdownTelemetry: () => Promise<void>,
): Promise<void> {
  try {
    if (listening) await app.close();
    else await app.close().catch(() => undefined);
  } catch {
    // Best-effort — the original error has higher priority for the user.
  }
  try {
    await shutdownTelemetry();
  } catch {
    // Same.
  }
}

/** Returns true when the admin row was created during this call. */
async function ensureLocalAdmin(databaseUrl: string): Promise<boolean> {
  if (await hasUser(databaseUrl)) return false;
  const username = sanitizeUsername(userInfo().username) || "admin";
  await createAdmin(databaseUrl, username, "default", username);
  return true;
}

export function sanitizeUsername(raw: string): string {
  return raw.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}

/**
 * Fastify default `host` is `127.0.0.1`. When the user binds `0.0.0.0`,
 * dialing back into the same process should still go through loopback so
 * the local-bootstrap gates pass.
 */
export function normaliseHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "::0") return "127.0.0.1";
  return host;
}

async function fetchLocalBootstrapTokens(serverUrl: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${serverUrl}/api/v1/auth/local-bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = await readErrorMessage(res);
    throw new Error(
      `Local bootstrap failed (HTTP ${res.status}). ${detail ?? "Check that the server is reachable on loopback."}`,
    );
  }
  return (await res.json()) as { accessToken: string; refreshToken: string };
}

async function readErrorMessage(res: Response): Promise<string | null> {
  try {
    const json = (await res.json()) as unknown;
    if (typeof json === "object" && json !== null && "error" in json) {
      const e = (json as { error: unknown }).error;
      if (typeof e === "string") return e;
    }
    return null;
  } catch {
    return null;
  }
}

export function shouldAutoOpenBrowser(options: StartCommandOptions): boolean {
  if (options.open === false) return false;
  if (process.env.SSH_CLIENT || process.env.SSH_TTY) return false;
  if (process.stdout.isTTY !== true) return false;
  return true;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: platform === "win32",
    });
    // Browser auto-open is best-effort; URL is also printed as a fallback.
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Same as above.
  }
}

export function isAddressInUseError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = Reflect.get(err, "code");
  return code === "EADDRINUSE";
}

function parsePortArg(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65_535) {
    throw new InvalidArgumentError(`Invalid port: '${value}' (expected an integer 1..65535)`);
  }
  return n;
}

/**
 * Probe the bind address with a throwaway listener. Throws an EADDRINUSE-
 * shaped error so the outer catch reuses the friendly hint without forking
 * code paths. Done before `bootstrapServer` so a port conflict doesn't
 * provision Postgres / run migrations / mint credentials we'd then orphan.
 */
function assertPortFree(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      reject(err);
    });
    probe.once("listening", () => {
      probe.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve();
      });
    });
    probe.listen(port, host);
  });
}
