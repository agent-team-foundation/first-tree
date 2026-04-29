/**
 * Minimal TS daemon entrypoint.
 *
 * This is the Phase 3a/3b read-path entrypoint plus the Phase 3c
 * broker/dispatcher startup. The daemon spins up the notification
 * poller, HTTP/SSE server, gh broker, bus, and dispatcher; SIGTERM
 * cascades through a single AbortController.
 *
 * Launch path:
 *   `first-tree auto daemon --backend=ts`
 * delegates here via `src/products/breeze/cli.ts`. The `rust` backend
 * continues to route through `bridge.ts::resolveBreezeRunner` and the
 * Rust `breeze-runner` binary; nothing in this file touches that path.
 *
 * Shutdown contract:
 *   - SIGTERM / SIGINT cascade through a single AbortController.
 *   - The poller observes `signal.aborted`, finishes any in-flight
 *     `pollOnce` (including draining the inbox.json advisory lock),
 *     then resolves.
 *   - Dispatcher.stop() aborts in-flight agent tasks and drains
 *     pending. Broker.stop() waits for the serve-loop to unwind.
 *   - The daemon exits with code 0 on clean shutdown, 1 on fatal error.
 *
 * Phase 4 note:
 *   Dispatcher submissions (turning notifications into candidates) are
 *   deferred. This entrypoint wires the lifecycle but does not yet
 *   feed the dispatcher — a future poller callback will `submit()` as
 *   notifications arrive.
 */

import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveAutoPaths } from "../runtime/paths.js";
import { loadAutoDaemonConfig, type DaemonConfig } from "../runtime/config.js";

import {
  resolveDaemonIdentity,
  identityHasRequiredScope,
  type DaemonIdentity,
} from "./identity.js";
import { acquireServiceLock, type ServiceLockHandle } from "./claim.js";
import { startHttpServer, type RunningHttpServer } from "./http.js";
import { pollOnce, runPoller, type PollerLogger } from "./poller.js";
import { GhClient as CoreGhClient } from "../runtime/gh.js";
import type { AutoPaths } from "../runtime/paths.js";
import { createBus, toSseBus, type Bus } from "./bus.js";
import { startGhBroker, type RunningBroker } from "./broker.js";
import { GhExecutor } from "./gh-executor.js";
import { Dispatcher } from "./dispatcher.js";
import { WorkspaceManager } from "./workspace.js";
import type { AgentSpec } from "./runner.js";
import { GhClient as BrokerGhClient } from "./gh-client.js";
import { runCandidateCycle, runCandidateLoop } from "./candidate-loop.js";
import { RepoFilter } from "../runtime/repo-filter.js";
import { Scheduler } from "./scheduler.js";
import { ThreadStore } from "./thread-store.js";
import { requireExplicitRepoFilter } from "../runtime/allow-repo.js";

export interface DaemonCliOverrides {
  pollIntervalSec?: number;
  host?: string;
  logLevel?: string;
  httpPort?: number;
  // taskTimeoutSec is read today but not yet consumed; kept for Phase 3b.
  taskTimeoutSec?: number;
  maxParallel?: number;
  searchLimit?: number;
  /**
   * Required comma-separated allow-list of repos the daemon may act on.
   * Patterns are `owner/repo` or `owner/*`.
   */
  allowRepo?: string;
}

export interface DaemonRunOptions {
  /** Parsed CLI overrides (from `--poll-interval-secs` etc). */
  cliOverrides?: DaemonCliOverrides;
  /** Whether to install SIGTERM/SIGINT handlers. Tests pass `false`. */
  installSignalHandlers?: boolean;
  /** Injected signal for tests (takes precedence over signal handlers). */
  signal?: AbortSignal;
  /** Logger override for tests. */
  logger?: PollerLogger;
  /**
   * When true, do exactly one candidate-poll cycle, wait until the
   * dispatcher drains (no active or pending tasks), then exit. Mirrors
   * the Rust `run_loop(once=true)` semantics. Used by the `run-once`
   * CLI command.
   */
  once?: boolean;
}

const DEFAULT_LOGGER: PollerLogger = {
  info: (line) => process.stdout.write(`${line}\n`),
  warn: (line) => process.stderr.write(`WARN: ${line}\n`),
  error: (line) => process.stderr.write(`ERROR: ${line}\n`),
};

/**
 * Parse the `--backend=...` / `--poll-interval-secs` style argv the
 * daemon accepts. Very small on purpose; breeze-runner has ~20 flags
 * but Phase 3a only needs a handful for the read path.
 *
 * Recognised flags:
 *   --poll-interval-secs <n>
 *   --host <host>
 *   --log-level <level>
 *   --http-port <n>
 *   --task-timeout-secs <n>
 *   --max-parallel <n>
 *   --search-limit <n>
 *   --allow-repo <csv>            (owner/repo,owner/* — required for daemon
 *                                  startup; scopes the daemon to listed repos)
 *
 * Both `--flag value` and `--flag=value` forms are accepted for
 * `--allow-repo`, `--max-parallel`, and `--search-limit`.
 *
 * Unknown flags are dropped silently in Phase 3a — they'll be parsed by
 * the future full-featured daemon in 3b/3c. This keeps the skeleton
 * forward-compatible with existing Rust-backend invocations.
 */
type DaemonFlagHandler = (
  overrides: DaemonCliOverrides,
  value: string,
) => void;

const DAEMON_FLAG_HANDLERS: Record<string, DaemonFlagHandler> = {
  "--allow-repo": (o, v) => {
    if (v.length > 0) o.allowRepo = v;
  },
  "--host": (o, v) => {
    o.host = v;
  },
  "--log-level": (o, v) => {
    o.logLevel = v;
  },
  "--poll-interval-sec": (o, v) => setPositiveInt(o, "pollIntervalSec", v),
  "--poll-interval-secs": (o, v) => setPositiveInt(o, "pollIntervalSec", v),
  "--task-timeout-sec": (o, v) => setPositiveInt(o, "taskTimeoutSec", v),
  "--task-timeout-secs": (o, v) => setPositiveInt(o, "taskTimeoutSec", v),
  "--max-parallel": (o, v) => setPositiveInt(o, "maxParallel", v),
  "--search-limit": (o, v) => setPositiveInt(o, "searchLimit", v),
  "--http-port": (o, v) => {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n > 0 && n < 65_536) o.httpPort = n;
  },
};

function setPositiveInt(
  overrides: DaemonCliOverrides,
  key: "pollIntervalSec" | "taskTimeoutSec" | "maxParallel" | "searchLimit",
  raw: string,
): void {
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) overrides[key] = n;
}

export function parseDaemonArgs(argv: readonly string[]): DaemonCliOverrides {
  const overrides: DaemonCliOverrides = {};
  const tokens = expandEqualsForms(argv);
  for (let i = 0; i < tokens.length; i += 1) {
    const arg = tokens[i];
    if (!arg) continue;
    const handler = DAEMON_FLAG_HANDLERS[arg];
    const value = tokens[i + 1];
    if (handler && value !== undefined) {
      handler(overrides, value);
      i += 1;
    }
    // Forward-compat: unknown flags are silently dropped.
  }
  return overrides;
}

/** Split `--key=value` into `["--key", "value"]` so the main loop can use a single dispatch table. */
function expandEqualsForms(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of argv) {
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        out.push(arg.slice(0, eq), arg.slice(eq + 1));
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}

/**
 * Install SIGTERM/SIGINT handlers that trigger the AbortController.
 * Returns a cleanup function that removes the handlers — tests should
 * call it to avoid polluting the signal table across test cases.
 */
function installShutdownHandlers(
  controller: AbortController,
  logger: PollerLogger,
): () => void {
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  const onSignal = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) return;
    logger.info(`received ${signal}; shutting down`);
    controller.abort();
  };
  const bound: Array<[NodeJS.Signals, (s: NodeJS.Signals) => void]> = [];
  for (const sig of signals) {
    const handler = (): void => onSignal(sig);
    process.on(sig, handler);
    bound.push([sig, handler]);
  }
  return () => {
    for (const [sig, handler] of bound) {
      process.off(sig, handler);
    }
  };
}

/**
 * Main daemon entry. Exits only on signal or fatal error.
 * Returns an exit code suitable for `process.exit`.
 */
export async function runDaemon(
  argv: readonly string[] = [],
  options: DaemonRunOptions = {},
): Promise<number> {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const cliOverrides = options.cliOverrides ?? parseDaemonArgs(argv);
  let repoFilter: RepoFilter;
  try {
    repoFilter = requireExplicitRepoFilter(cliOverrides.allowRepo);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const config = loadConfigOrLog(cliOverrides, logger);
  if (!config) return 1;

  const paths = resolveAutoPaths();
  const runnerHome = resolveRunnerHome();
  const identity = resolveStartupIdentity(config.host, logger);

  // Phase 5 singleton: one daemon per (host, login, profile) on this
  // machine. The previous HTTP-port-only guard let a second daemon
  // spin up its broker + dispatcher before the port conflict surfaced,
  // so two dispatchers could briefly race on the same claim dir. This
  // hard-rejects a racing start before any stateful work begins.
  //
  const lockResult = await tryAcquireServiceLock({
    runnerHome,
    identity,
    aborted: options.signal?.aborted ?? false,
    logger,
  });
  if (lockResult === "fail") return 1;
  let lockHandle: ServiceLockHandle | null = lockResult;

  const { controller, uninstallHandlers } = wireAbortCascade({
    signal: options.signal,
    installSignalHandlers: options.installSignalHandlers ?? true,
    logger,
  });

  let dispatcher: Dispatcher | null = null;
  const { publishRuntimeStatus, runtimeTicker } = setupRuntimeReporting({
    runnerHome,
    config,
    identity,
    repoFilter,
    logger,
    getDispatcher: () => dispatcher,
    getLockHandle: () => lockHandle,
  });

  // Phase 3c: shared in-process bus drives SSE + broker task events.
  const bus = createBus({
    onListenerError: (err) =>
      logger.warn(
        `bus listener threw: ${err instanceof Error ? err.message : String(err)}`,
      ),
  });

  // Phase 3c: start gh broker + dispatcher if agents are available.
  // Absence of codex/claude is non-fatal; the daemon still runs as
  // read-only (poller + http).
  const dispatchSetup = await tryStartBrokerAndDispatcher({
    runnerHome,
    paths,
    config,
    repoFilter,
    bus,
    logger,
    controller,
    once: options.once ?? false,
    publishRuntimeStatus,
  });
  let broker: RunningBroker | null = dispatchSetup.broker;
  let candidateLoopDone: Promise<void> | null = dispatchSetup.candidateLoopDone;
  let candidateRuntime = dispatchSetup.candidateRuntime;
  dispatcher = dispatchSetup.dispatcher;

  const httpStart = await startHttpOrPartialCleanup({
    controller,
    config,
    paths,
    bus,
    logger,
    onFail: async () => {
      clearInterval(runtimeTicker);
      if (dispatcher) await dispatcher.stop();
      if (broker) await broker.stop();
      if (uninstallHandlers) uninstallHandlers();
      if (lockHandle) await lockHandle.release().catch(() => undefined);
    },
  });
  if (httpStart === "fail") return 1;
  const httpServer: RunningHttpServer | null = httpStart;
  publishRuntimeStatus("running");

  let exitCode = 0;
  try {
    await runPollLoop({
      once: options.once ?? false,
      config,
      paths,
      controller,
      logger,
      dispatcher,
      candidateRuntime,
      bus,
    });
  } catch (err) {
    logger.error(
      `poller exited with error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
    );
    exitCode = 1;
  } finally {
    await shutdownDaemon({
      controller,
      runtimeTicker,
      candidateLoopDone,
      dispatcher,
      broker,
      httpServer,
      bus,
      uninstallHandlers,
      lockHandle,
      logger,
    });
  }

  logger.info("auto daemon: shutdown complete");
  return exitCode;
}

function loadConfigOrLog(
  cliOverrides: DaemonCliOverrides,
  logger: PollerLogger,
): DaemonConfig | null {
  try {
    return loadAutoDaemonConfig({ cliOverrides });
  } catch (err) {
    logger.error(
      `failed to load daemon config: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Phase 5 singleton: one daemon per (host, login, profile) on this
 * machine. The previous HTTP-port-only guard let a second daemon spin
 * up its broker + dispatcher before the port conflict surfaced, so two
 * dispatchers could briefly race on the same claim dir. This
 * hard-rejects a racing start before any stateful work begins.
 *
 * Skipped when identity resolution failed — that path keeps old
 * read-only degraded semantics for operators without a gh login.
 * Skip when signal is already aborted — we'd release immediately
 * anyway, and touching the durable lock dir risks thrashing a
 * legitimately-running daemon's state. Matches the HTTP-server
 * pre-abort guard below.
 */
async function tryAcquireServiceLock(args: {
  runnerHome: string;
  identity: DaemonIdentity | null;
  aborted: boolean;
  logger: PollerLogger;
}): Promise<ServiceLockHandle | null | "fail"> {
  if (!args.identity || args.aborted) return null;
  try {
    return await acquireServiceLock({
      baseDir: join(args.runnerHome, "locks"),
      identity: args.identity,
      profile: "default",
      note: "daemon starting",
    });
  } catch (err) {
    args.logger.error(
      `auto daemon: refusing to start — ${err instanceof Error ? err.message : String(err)}`,
    );
    return "fail";
  }
}

/** Tests may pass a pre-built signal directly; otherwise install SIGTERM/SIGINT handlers. */
function wireAbortCascade(args: {
  signal?: AbortSignal;
  installSignalHandlers: boolean;
  logger: PollerLogger;
}): { controller: AbortController; uninstallHandlers: (() => void) | null } {
  const controller = new AbortController();
  const uninstallHandlers = args.installSignalHandlers
    ? installShutdownHandlers(controller, args.logger)
    : null;
  if (args.signal) {
    if (args.signal.aborted) controller.abort();
    else
      args.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }
  return { controller, uninstallHandlers };
}

/**
 * Identity resolution is best-effort at startup. The daemon will still
 * try to poll if identity fails — the poller uses the host-only env,
 * not the login. But we log loudly so operators notice.
 */
function resolveStartupIdentity(
  host: string,
  logger: PollerLogger,
): DaemonIdentity | null {
  try {
    const identity = resolveDaemonIdentity({ host });
    if (!identityHasRequiredScope(identity)) {
      logger.warn(
        `gh token for ${identity.login}@${identity.host} lacks \`repo\`/\`notifications\` scope; poll may return empty results`,
      );
    } else {
      logger.info(`auto daemon: identity=${identity.login}@${identity.host}`);
    }
    return identity;
  } catch (err) {
    logger.warn(
      `identity resolution failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

type RuntimeStatusPublisher = (
  note?: string,
  extra?: Record<string, string | undefined>,
) => void;

/**
 * Build the runtime-status publisher and its periodic ticker, log the
 * startup summary, and emit the initial "daemon starting" snapshot.
 */
function setupRuntimeReporting(args: {
  runnerHome: string;
  config: DaemonConfig;
  identity: DaemonIdentity | null;
  repoFilter: RepoFilter;
  logger: PollerLogger;
  getDispatcher: () => Dispatcher | null;
  getLockHandle: () => ServiceLockHandle | null;
}): { publishRuntimeStatus: RuntimeStatusPublisher; runtimeTicker: NodeJS.Timeout } {
  const { runnerHome, config, identity, repoFilter, logger, getDispatcher, getLockHandle } = args;
  const allowedReposLabel = repoFilter.isEmpty() ? "all" : repoFilter.displayPatterns();
  const identityLabel = identity
    ? `${identity.login}@${identity.host}`
    : `unknown@${config.host}`;
  const publishRuntimeStatus = createRuntimeStatusPublisher({
    runnerHome,
    identityLabel,
    allowedReposLabel,
    getActiveCount: () => getDispatcher()?.activeCount() ?? 0,
    getQueuedCount: () => getDispatcher()?.pendingCount() ?? 0,
    getLockHandle,
  });
  publishRuntimeStatus();
  const runtimeRefreshMs = Math.max(
    1_000,
    Math.min(config.pollIntervalSec * 1_000, 30_000),
  );
  const runtimeTicker = setInterval(() => publishRuntimeStatus(), runtimeRefreshMs);
  runtimeTicker.unref?.();

  logger.info(
    `auto daemon: poll-interval=${config.pollIntervalSec}s host=${config.host} http-port=${config.httpPort} max-parallel=${config.maxParallel} search-limit=${config.searchLimit} allow-repo=${allowedReposLabel}`,
  );
  return { publishRuntimeStatus, runtimeTicker };
}

function createRuntimeStatusPublisher(args: {
  runnerHome: string;
  identityLabel: string;
  allowedReposLabel: string;
  getActiveCount: () => number;
  getQueuedCount: () => number;
  getLockHandle: () => ServiceLockHandle | null;
}): RuntimeStatusPublisher {
  const runtimeStore = new ThreadStore({ runnerHome: args.runnerHome });
  const status: Record<string, string> = {
    last_identity: args.identityLabel,
    allowed_repos: args.allowedReposLabel,
    active_tasks: "0",
    queued_tasks: "0",
    last_note: "daemon starting",
  };
  return (note, extra = {}) => {
    if (note !== undefined) status.last_note = note;
    status.last_identity = args.identityLabel;
    status.allowed_repos = args.allowedReposLabel;
    status.active_tasks = String(args.getActiveCount());
    status.queued_tasks = String(args.getQueuedCount());
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined || value.length === 0) delete status[key];
      else status[key] = value;
    }
    runtimeStore.writeRuntimeStatus(status);
    args
      .getLockHandle()
      ?.refresh(
        Number.parseInt(status.active_tasks, 10) || 0,
        status.last_note,
      );
  };
}

/**
 * Bind the read-only HTTP + SSE server. If the shared controller is
 * already aborted (tests inject a pre-aborted signal; real SIGTERM
 * arrives later), skip binding: we would close immediately anyway and
 * we'd rather not touch the listener table in fast-exit paths.
 *
 * On bind failure, run `onFail` (caller-supplied partial cleanup) and
 * return "fail" so the caller can `return 1`.
 */
async function startHttpOrPartialCleanup(args: {
  controller: AbortController;
  config: DaemonConfig;
  paths: AutoPaths;
  bus: Bus;
  logger: PollerLogger;
  onFail: () => Promise<void>;
}): Promise<RunningHttpServer | null | "fail"> {
  if (args.controller.signal.aborted) return null;
  try {
    return await startHttpServer({
      httpPort: args.config.httpPort,
      inboxPath: args.paths.inbox,
      activityLogPath: args.paths.activityLog,
      bus: toSseBus(args.bus),
      signal: args.controller.signal,
      logger: args.logger,
    });
  } catch (err) {
    args.logger.error(
      `failed to start http server: ${err instanceof Error ? err.message : String(err)}`,
    );
    await args.onFail();
    return "fail";
  }
}

async function runPollLoop(args: {
  once: boolean;
  config: DaemonConfig;
  paths: AutoPaths;
  controller: AbortController;
  logger: PollerLogger;
  dispatcher: Dispatcher | null;
  candidateRuntime: CandidateRuntime | null;
  bus: Bus;
}): Promise<void> {
  const { once, config, paths, controller, logger, dispatcher, candidateRuntime, bus } = args;
  if (!once) {
    await runPoller({
      pollIntervalSec: config.pollIntervalSec,
      host: config.host,
      paths,
      signal: controller.signal,
      logger,
    });
    return;
  }
  // One-shot: run a single poll cycle, then wait for the dispatcher
  // to drain. Also run one candidate-search cycle so
  // assigned/review-requested work is not lost before shutdown.
  await runPollerOnce(config, paths, controller.signal, logger);
  if (candidateRuntime) {
    const outcome = await runCandidateCycle(
      {
        client: candidateRuntime.client,
        dispatcher: candidateRuntime.dispatcher,
        searchLimit: config.searchLimit,
        includeSearch: true,
        lookbackSecs: 24 * 3_600,
        scheduler: candidateRuntime.scheduler,
      },
      () => Math.floor(Date.now() / 1_000),
    );
    logCandidateOutcome(outcome, logger, bus);
  }
  if (dispatcher) await waitForDispatcherDrain(dispatcher, controller.signal);
}

/**
 * Shutdown order:
 *   SIGTERM -> stop poller (already returned) -> flush store
 *   (poller's atomic tmp+rename drains in updateInbox) -> stop
 *   dispatcher (aborts in-flight agent tasks) -> stop broker (drains
 *   serve loop) -> stop http -> close bus -> exit.
 */
async function shutdownDaemon(args: {
  controller: AbortController;
  runtimeTicker: NodeJS.Timeout;
  candidateLoopDone: Promise<void> | null;
  dispatcher: Dispatcher | null;
  broker: RunningBroker | null;
  httpServer: RunningHttpServer | null;
  bus: Bus;
  uninstallHandlers: (() => void) | null;
  lockHandle: ServiceLockHandle | null;
  logger: PollerLogger;
}): Promise<void> {
  const { controller, runtimeTicker, candidateLoopDone, dispatcher, broker, httpServer, bus, uninstallHandlers, lockHandle, logger } = args;
  clearInterval(runtimeTicker);
  if (!controller.signal.aborted) controller.abort();
  if (candidateLoopDone) {
    await suppressShutdownError("candidate loop", () => candidateLoopDone, logger);
  }
  if (dispatcher) {
    await suppressShutdownError("dispatcher", () => dispatcher.stop(), logger);
  }
  if (broker) {
    await suppressShutdownError("broker", () => broker.stop(), logger);
  }
  if (httpServer) {
    await suppressShutdownError("http server", () => httpServer.done, logger);
  }
  bus.close();
  if (uninstallHandlers) uninstallHandlers();
  if (lockHandle) {
    await suppressShutdownError("service lock release", () => lockHandle.release(), logger);
  }
}

async function suppressShutdownError(
  label: string,
  task: () => Promise<unknown>,
  logger: PollerLogger,
): Promise<void> {
  try {
    await task();
  } catch (err) {
    logger.warn(
      `${label} shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface CandidateRuntime {
  client: BrokerGhClient;
  dispatcher: Dispatcher;
  scheduler: Scheduler;
}

interface DispatchSetup {
  broker: RunningBroker | null;
  dispatcher: Dispatcher | null;
  candidateLoopDone: Promise<void> | null;
  candidateRuntime: CandidateRuntime | null;
}

/**
 * Bring up the gh broker, dispatcher, and (when we're not running
 * one-shot) the candidate loop that feeds the dispatcher from GitHub.
 * Failures are logged and degrade gracefully — the caller still runs
 * the poller + HTTP server in read-only mode.
 */
async function tryStartBrokerAndDispatcher(args: {
  runnerHome: string;
  paths: AutoPaths;
  config: DaemonConfig;
  repoFilter: RepoFilter;
  bus: Bus;
  logger: PollerLogger;
  controller: AbortController;
  once: boolean;
  publishRuntimeStatus: (
    note?: string,
    extra?: Record<string, string | undefined>,
  ) => void;
}): Promise<DispatchSetup> {
  const { runnerHome, paths, config, repoFilter, bus, logger, controller, once, publishRuntimeStatus } = args;
  const setup: DispatchSetup = {
    broker: null,
    dispatcher: null,
    candidateLoopDone: null,
    candidateRuntime: null,
  };
  try {
    const agents = detectAvailableAgents();
    const realGh = findExecutable("gh");
    if (agents.length === 0 || !realGh) {
      const missing: string[] = [];
      if (agents.length === 0) missing.push("no codex/claude on PATH");
      if (!realGh) missing.push("no gh on PATH");
      logger.warn(
        `auto daemon: skipping broker/dispatcher (${missing.join("; ")})`,
      );
      return setup;
    }
    const identity = resolveDaemonIdentity({ host: config.host });
    const executor = new GhExecutor({
      realGh,
      writeCooldownMs: 1_000,
      signal: controller.signal,
    });
    setup.broker = await startGhBroker({
      brokerDir: join(runnerHome, "broker"),
      executor,
      logger: {
        warn: (line) => logger.warn(`broker: ${line}`),
        error: (line) => logger.error(`broker: ${line}`),
      },
    });
    const candidateClient = new BrokerGhClient({
      host: identity.host,
      repoFilter,
      executor,
    });
    const scheduler = new Scheduler({
      store: new ThreadStore({ runnerHome }),
      ghClient: candidateClient,
      identity: { host: identity.host, login: identity.login },
      pollIntervalSec: config.pollIntervalSec,
      logger,
    });
    setup.dispatcher = new Dispatcher({
      runnerHome,
      identity: { host: identity.host, login: identity.login },
      agents,
      workspaceManager: new WorkspaceManager({
        reposDir: join(runnerHome, "repos"),
        workspacesDir: join(runnerHome, "workspaces"),
        identity: { host: identity.host, login: identity.login },
      }),
      bus,
      ghShimDir: setup.broker.shimDir,
      ghBrokerDir: setup.broker.brokerDir,
      claimsDir: paths.claimsDir,
      disclosureText:
        "This reply was drafted by breeze, an autonomous agent running on behalf of the account owner.",
      maxParallel: config.maxParallel,
      taskTimeoutMs: config.taskTimeoutSec * 1_000,
      logger,
      onCompletion: (record) => scheduler.handleCompletion(record),
    });
    logger.info(
      `auto daemon: dispatcher ready (agents=${agents.map((r) => r.kind).join(",")}, broker=${setup.broker.shimDir})`,
    );
    setup.candidateRuntime = {
      client: candidateClient,
      dispatcher: setup.dispatcher,
      scheduler,
    };
    if (!once) {
      // Phase 4: candidate loop — feeds the dispatcher from GitHub.
      setup.candidateLoopDone = runCandidateLoop({
        client: candidateClient,
        dispatcher: setup.dispatcher,
        bus,
        pollIntervalSec: config.pollIntervalSec,
        searchLimit: config.searchLimit,
        includeSearch: true,
        lookbackSecs: 24 * 3_600,
        signal: controller.signal,
        logger,
        scheduler,
        onCycle: () =>
          publishRuntimeStatus(undefined, {
            next_search_reconcile_epoch: String(
              Math.floor(Date.now() / 1_000) + config.pollIntervalSec,
            ),
          }),
        recoverableCandidates: () =>
          scheduler.enqueueRecoverableTasks(identity.host),
      }).catch((err) => {
        logger.error(
          `candidate loop crashed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    return setup;
  } catch (err) {
    logger.error(
      `failed to start broker/dispatcher: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Continue without dispatcher; still run poller + http.
    return setup;
  }
}

/**
 * Walk PATH looking for a best-effort set of agent binaries. Returns
 * the specs in the order we'd prefer as the primary agent. Missing
 * binaries are silently omitted — the caller decides whether that is
 * fatal.
 */
export function detectAvailableAgents(): AgentSpec[] {
  const agents: AgentSpec[] = [];
  if (findExecutable("codex")) agents.push({ kind: "codex" });
  if (findExecutable("claude")) agents.push({ kind: "claude" });
  return agents;
}

/** Return the absolute path to `name` on PATH, or null if not found. */
export function findExecutable(name: string): string | null {
  try {
    const out = execSync(`command -v ${name}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * `$AUTO_HOME` or `$AUTO_DIR/runner`, defaulting to
 * `~/.first-tree/auto/runner`. Matches `resolve_inbox_dir` in Rust `fetcher.rs`.
 */
export function resolveRunnerHome(
  env: (name: string) => string | undefined = (n) => process.env[n],
): string {
  const autoHome = env("AUTO_HOME");
  if (autoHome && autoHome.length > 0) return autoHome;
  const autoDir = env("AUTO_DIR");
  if (autoDir && autoDir.length > 0) return join(autoDir, "runner");
  return join(homedir(), ".first-tree", "auto", "runner");
}

function logCandidateOutcome(
  outcome: Awaited<ReturnType<typeof runCandidateCycle>>,
  logger: PollerLogger,
  bus: Bus,
): void {
  for (const warning of outcome.warnings) {
    logger.warn(`candidates: ${warning}`);
    bus.publish({ kind: "activity", line: warning });
  }
  if (outcome.rateLimited) {
    logger.warn("candidate search rate-limited during one-shot cycle");
  }
  if (outcome.submitted > 0) {
    logger.info(`candidates: submitted ${outcome.submitted} task(s)`);
  }
}

/**
 * Run exactly one inbox-poll cycle against `pollOnce`. Mirrors Rust
 * `fetcher.poll_once`. Used by the `run-once` path.
 */
async function runPollerOnce(
  config: DaemonConfig,
  paths: AutoPaths,
  signal: AbortSignal,
  logger: PollerLogger,
): Promise<void> {
  if (signal.aborted) return;
  try {
    const outcome = await pollOnce({
      gh: new CoreGhClient(),
      paths,
      host: config.host,
      now: Date.now,
    });
    for (const warning of outcome.warnings) logger.warn(warning);
    logger.info(
      `auto: polled ${outcome.total} notifications (${outcome.newCount} new)`,
    );
  } catch (err) {
    logger.warn(
      `run-once poll failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Wait until the dispatcher has no active or pending tasks, or the
 * signal fires. Polls the dispatcher counters every 250ms.
 */
async function waitForDispatcherDrain(
  dispatcher: Dispatcher,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    if (dispatcher.activeCount() === 0 && dispatcher.pendingCount() === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

export default runDaemon;
