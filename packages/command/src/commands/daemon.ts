import { join } from "node:path";
import {
  clientConfigSchema,
  DEFAULT_CONFIG_DIR,
  DEFAULT_HOME_DIR,
  initConfig,
  resetConfig,
  resetConfigMeta,
  setConfigValue,
} from "@agent-team-foundation/first-tree-hub-shared/config";
import { configureClientLoggerForService } from "@first-tree-hub/client";
import { type Command, InvalidArgumentError } from "commander";
import { saveCredentials } from "../core/bootstrap.js";
import { ClientRuntime } from "../core/client-runtime.js";
import { obtainDaemonJWT } from "../core/daemon-auth.js";
import { createExecuteUpdate, promptUpdate } from "../core/index.js";
import { print, status } from "../core/output.js";
import { assertSchemaCurrent } from "../core/schema-version-guard.js";
import { bootstrapServer } from "../core/server.js";
import { COMMAND_VERSION } from "../core/version.js";

type DaemonOptions = {
  port?: number;
  host?: string;
  databaseUrl?: string;
};

function parsePortArg(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65_535) {
    throw new InvalidArgumentError(`Invalid port: '${value}' (expected an integer 1..65535)`);
  }
  return n;
}

/**
 * Hidden `first-tree-hub daemon` subcommand — the entry point launchd /
 * systemd-user invokes after `start --service` installs the unit.
 *
 * Pattern B (Q11) — the daemon does NOT re-run install-time work
 * (Postgres, migrations, createAdmin). Those are owned by the CLI parent.
 * The daemon's only orchestration on every boot:
 *
 *   1. `assertSchemaCurrent` — fail-fast on version drift between the
 *      bundled migrations and the live DB. Surfaces the upgrade-without-
 *      restart bug in `service logs`.
 *   2. `bootstrapServer` — telemetry init + buildApp (no migrations; the
 *      bootstrap path runs `runMigrations` but it's a no-op when the DB
 *      is already current, so the cost is negligible).
 *   3. `app.listen`.
 *   4. `obtainDaemonJWT` 3-tier recovery (Q9 / B2).
 *   5. Embedded `ClientRuntime` startup.
 *   6. Block until SIGTERM.
 */
export function registerDaemonCommand(program: Command): void {
  program
    .command("daemon", { hidden: true })
    .description("Hub daemon entry point (invoked by launchd / systemd-user)")
    .option("--port <number>", "Port (passed through from start --service)", parsePortArg)
    .option("--host <address>", "Bind address")
    .option("--database-url <url>", "External PostgreSQL URL")
    .action(async (options: DaemonOptions) => {
      try {
        await runDaemon(options);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // The daemon's stderr is captured by launchd / systemd into the
        // platform log; log the message so `service logs` shows it.
        process.stderr.write(`first-tree-hub daemon error: ${msg}\n`);
        process.exit(1);
      }
    });
}

async function runDaemon(options: DaemonOptions): Promise<void> {
  // Route the client logger to a rotating NDJSON file under the same logs/
  // dir launchd / systemd capture stdout into. Done first so any later
  // failure surfaces in `service logs`. The function is idempotent for
  // direct (non-service) invocations; in non-service mode the operator
  // sees raw stdout instead.
  if (process.env.FIRST_TREE_HUB_SERVICE_MODE === "1") {
    configureClientLoggerForService(join(DEFAULT_HOME_DIR, "logs"), "daemon");
  }

  print.line(`\n  First Tree Hub daemon v${COMMAND_VERSION}\n\n`);

  // Step 1: schema-version guard. Run before bootstrapServer so we never
  // build the fastify app against an unexpected schema.
  const { url } = await resolveDatabaseUrl(options.databaseUrl);
  await assertSchemaCurrent(url, COMMAND_VERSION);
  status("Schema", "current");

  // Step 2: bootstrap. `bootstrapServer` includes `runMigrations`, which
  // is idempotent — by the time we reach here, the schema guard already
  // confirmed it is a no-op. Keeping it in the path means a daemon that
  // somehow gets ahead of its parent (downgrade) still applies pending
  // migrations on its own; the schema guard pre-empts the more dangerous
  // upgrade-without-restart case.
  const { app, config, shutdownTelemetry } = await bootstrapServer({
    port: options.port,
    host: options.host,
    databaseUrl: options.databaseUrl,
    noInteractive: true,
  });

  await app.listen({ host: config.server.host, port: config.server.port });
  status("Server", `listening at http://${config.server.host}:${config.server.port}`);

  const serverUrl = `http://${normaliseDaemonHost(config.server.host)}:${config.server.port}`;
  setConfigValue(join(DEFAULT_CONFIG_DIR, "client.yaml"), "server.url", serverUrl);
  resetConfig();
  resetConfigMeta();
  const clientConfig = await initConfig({ schema: clientConfigSchema, role: "client" });

  // Step 4: 3-tier JWT recovery (Q9). Persist the resulting pair so
  // subsequent boots take the cached path.
  const tokens = await obtainDaemonJWT(serverUrl);
  saveCredentials(tokens);
  status("Client", `connected as ${clientConfig.client.id}`);

  const runtime = new ClientRuntime(clientConfig.server.url, clientConfig.client.id, {
    currentVersion: COMMAND_VERSION,
    update: {
      updateConfig: clientConfig.update,
      prompt: promptUpdate,
      executeUpdate: createExecuteUpdate({ managed: true }),
    },
  });
  const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
  await runtime.start();
  runtime.watchAgentsDir(agentsDir);

  await blockUntilSigterm(runtime, app, shutdownTelemetry);
}

function blockUntilSigterm(
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
        let exitCode = 0;
        try {
          runtime.unwatchAgentsDir();
        } catch {
          exitCode = 1;
        }
        try {
          await runtime.stop();
        } catch {
          exitCode = 1;
        }
        try {
          await app.close();
        } catch {
          exitCode = 1;
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

/**
 * The daemon binds whatever the unit file passes as `--port` (default
 * 8000). Loopback dial-in for `local-bootstrap` must use 127.0.0.1 even if
 * the bind address is wildcard.
 */
function normaliseDaemonHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "::0") return "127.0.0.1";
  return host;
}

/**
 * Resolve the database URL without mutating the config singleton, so the
 * subsequent `bootstrapServer` call inside `runDaemon` performs the
 * canonical (CLI-args-aware) `initConfig` itself.
 */
async function resolveDatabaseUrl(cliOverride: string | undefined): Promise<{ url: string }> {
  if (cliOverride) return { url: cliOverride };
  const { resolveConfigReadonly, serverConfigSchema } = await import(
    "@agent-team-foundation/first-tree-hub-shared/config"
  );
  const cfg = resolveConfigReadonly({ schema: serverConfigSchema, role: "server" });
  const db = cfg.database;
  if (typeof db !== "object" || db === null) {
    throw new Error("database.url is not configured. Run `first-tree-hub start --service` to (re)install.");
  }
  const url = Reflect.get(db, "url");
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("database.url is not configured. Run `first-tree-hub start --service` to (re)install.");
  }
  return { url };
}
