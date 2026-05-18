import { randomBytes } from "node:crypto";
import { type ClientProcess, spawnClient } from "./client-process.js";
import { type ProvisionedCredentials, provisionTestCredentials } from "./credentials.js";
import { bestEffortCleanupStaleContainers, type PgProcess, startDockerPg } from "./docker-pg.js";
import { runDoctor } from "./doctor.js";
import { type E2EEnv, loadE2EEnv, PACKAGE_E2E_ROOT, REPO_ROOT } from "./env.js";
import { type GitHubAppFixture, makeGitHubAppFixture } from "./github-app-fixture.js";
import { makeRunIdentity, type RunIdentity } from "./isolation.js";
import { type ComponentLogger, createComponentLogger, dumpTailToConsole } from "./logging.js";
import { allocatePorts } from "./ports.js";
import { type ServerProcess, type ServerSpawnOptions, spawnServer } from "./server-process.js";

/**
 * M2 boots `pg + server` and — when `withClient: true` — provisions a real
 * user via raw-SQL helper + JWT minting, writes credentials.json into the
 * run-scoped home, and spawns `client start --foreground` against the live
 * server. The provisioned identifiers (userId / orgId / agentIds / clientId)
 * are surfaced on the returned world so tests can drive real HTTP requests
 * without re-deriving them.
 */
export type StartRunOptions = {
  /**
   * When true, spawn `client start --foreground` after provisioning a real
   * user + connecting credentials. M1 default: false.
   */
  withClient?: boolean;
  /**
   * Extra env injected into the spawned server process. Used by mocks (e.g.
   * `github-mock` sets `FIRST_TREE_HUB_GITHUB_API_BASE_URL` +
   * `FIRST_TREE_HUB_GITHUB_APP_*`) so the server's outbound calls land on
   * the mock instead of api.github.com.
   */
  serverExtraEnv?: ServerSpawnOptions["extraEnv"];
};

export type RunWorld = {
  identity: RunIdentity;
  env: E2EEnv;
  pg: PgProcess;
  server: ServerProcess;
  /** Present only when `startRunWorld({ withClient: true })`. */
  client: ClientProcess | null;
  /** Present only when `startRunWorld({ withClient: true })`. */
  credentials: ProvisionedCredentials | null;
  /** JWT secret the server was spawned with — exposed so tests can mint extra tokens. */
  jwtSecret: string;
  /** Ephemeral GitHub App credentials the server was booted with. */
  githubApp: GitHubAppFixture;
  loggers: ComponentLogger[];
};

let activeWorld: RunWorld | null = null;
let teardownHooksRegistered = false;

export async function startRunWorld(opts: StartRunOptions = {}): Promise<RunWorld> {
  if (activeWorld) {
    throw new Error("E2E run world is already active — global setup is not reentrant");
  }
  const withClient = opts.withClient ?? false;

  const env = loadE2EEnv();
  const doctor = runDoctor(REPO_ROOT);
  if (!doctor.ok) {
    const formatted = doctor.issues.map((i) => `  [${i.kind}] ${i.what}: ${i.detail}`).join("\n");
    throw new Error(`E2E doctor failed:\n${formatted}`);
  }
  const composeBin = env.E2E_DOCKER_COMPOSE_BIN ?? doctor.dockerComposeBin;
  if (!composeBin) throw new Error("E2E doctor passed but no docker compose binary resolved — internal bug");

  bestEffortCleanupStaleContainers(composeBin);

  const identity = makeRunIdentity(PACKAGE_E2E_ROOT, env.E2E_RUN_ID);
  const loggers: ComponentLogger[] = [];

  registerProcessExitHooks();

  let pg: PgProcess | undefined;
  let server: ServerProcess | undefined;
  let client: ClientProcess | undefined;
  let credentials: ProvisionedCredentials | null = null;

  // Generate JWT secret + GitHub App fixture up here (instead of inside
  // `spawnServer`) so the framework can mint tokens / sign webhook payloads
  // that the same server will validate. The github-app block is set
  // unconditionally — server boot guards refuse a half-configured block, so
  // even server-only smoke needs the bundle to be coherent.
  const jwtSecret = randomBytes(32).toString("base64url");
  const githubApp = makeGitHubAppFixture();

  try {
    const [pgPort, serverPort] = await allocatePorts(env.E2E_PORT_MIN, env.E2E_PORT_MAX, 2);
    if (pgPort === undefined || serverPort === undefined) {
      throw new Error("Failed to allocate the two ports needed for M1 (pg + server)");
    }

    pg = await startDockerPg({
      identity,
      port: pgPort,
      pgImage: env.E2E_PG_IMAGE,
      composeBin,
    });

    const serverLogger = createComponentLogger(identity.runDir, "server");
    loggers.push(serverLogger);
    server = await spawnServer({
      identity,
      port: serverPort,
      databaseUrl: pg.databaseUrl,
      logger: serverLogger,
      jwtSecret,
      extraEnv: { ...githubApp.toServerEnv(), ...opts.serverExtraEnv },
    });

    if (withClient) {
      credentials = await provisionTestCredentials({
        databaseUrl: pg.databaseUrl,
        jwtSecret,
        serverUrl: server.baseUrl,
        home: identity.home,
      });

      const clientLogger = createComponentLogger(identity.runDir, "client");
      loggers.push(clientLogger);
      client = await spawnClient({
        identity,
        serverBaseUrl: server.baseUrl,
        logger: clientLogger,
      });
    }

    activeWorld = {
      identity,
      env,
      pg,
      server,
      client: client ?? null,
      credentials,
      jwtSecret,
      githubApp,
      loggers,
    };
    return activeWorld;
  } catch (err) {
    dumpTailToConsole(loggers);
    await safeStop(client, "client");
    await safeStop(server, "server");
    await safeStop(pg, "pg");
    for (const l of loggers) l.close();
    throw err;
  }
}

export async function stopRunWorld(): Promise<void> {
  if (!activeWorld) return;
  const { pg, server, client, loggers, identity } = activeWorld;
  activeWorld = null;
  const errors: unknown[] = [];
  const stoppers: Array<readonly [string, { stop: () => Promise<void> } | null]> = [
    ["client", client],
    ["server", server],
    ["pg", pg],
  ];
  for (const [name, comp] of stoppers) {
    if (!comp) continue;
    try {
      await comp.stop();
    } catch (err) {
      errors.push(err);
      console.error(`[lifecycle] ${name} stop failed for run ${identity.runId}:`, err);
    }
  }
  // E2E_KEEP_LOGS is honoured by scripts/clean.ts (it controls whether the
  // next `e2e:clean` skips pruning the previous run). Files always land on
  // disk so failure forensics survive Ctrl-C.
  for (const l of loggers) l.close();
  if (errors.length > 0) {
    throw new AggregateError(errors as Error[], "lifecycle stop encountered failures");
  }
}

export function getActiveWorld(): RunWorld {
  if (!activeWorld) throw new Error("E2E world is not active — was globalSetup wired up?");
  return activeWorld;
}

async function safeStop(component: { stop: () => Promise<void> } | undefined, name: string): Promise<void> {
  if (!component) return;
  try {
    await component.stop();
  } catch (err) {
    console.error(`[lifecycle] failed to stop ${name} during teardown:`, err);
  }
}

function registerProcessExitHooks(): void {
  if (teardownHooksRegistered) return;
  teardownHooksRegistered = true;
  const handler = (signal: NodeJS.Signals) => {
    console.error(`[lifecycle] received ${signal}, tearing down e2e world`);
    void stopRunWorld().finally(() => process.exit(130));
  };
  process.once("SIGINT", () => handler("SIGINT"));
  process.once("SIGTERM", () => handler("SIGTERM"));
}
