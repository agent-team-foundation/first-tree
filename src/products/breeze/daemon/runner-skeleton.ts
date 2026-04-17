/**
 * Minimal TS daemon entrypoint.
 *
 * This is the Phase 3a/3b read-path entrypoint plus the Phase 3c
 * broker/dispatcher startup. The daemon spins up the notification
 * poller, HTTP/SSE server, gh broker, bus, and dispatcher; SIGTERM
 * cascades through a single AbortController.
 *
 * Launch path:
 *   `first-tree breeze daemon --backend=ts`
 * delegates here via `src/products/breeze/cli.ts`. The `rust` backend
 * continues to route through `bridge.ts::resolveBreezeRunner` and the
 * Rust `breeze-runner` binary; nothing in this file touches that path.
 *
 * Shutdown contract:
 *   - SIGTERM / SIGINT cascade through a single AbortController.
 *   - The poller observes `signal.aborted`, finishes any in-flight
 *     `pollOnce` (including draining the inbox.json advisory lock),
 *     then resolves.
 *   - Dispatcher.stop() aborts in-flight runner tasks and drains
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

import { resolveBreezePaths } from "../core/paths.js";
import { loadBreezeDaemonConfig, type DaemonConfig } from "../core/config.js";

import { resolveDaemonIdentity, identityHasRequiredScope } from "./identity.js";
import { startHttpServer, type RunningHttpServer } from "./http.js";
import { runPoller, type PollerLogger } from "./poller.js";
import { createBus, toSseBus, type Bus } from "./bus.js";
import { startGhBroker, type RunningBroker } from "./broker.js";
import { GhExecutor } from "./gh-executor.js";
import { Dispatcher } from "./dispatcher.js";
import { WorkspaceManager } from "./workspace.js";
import type { RunnerSpec } from "./runner.js";
import { GhClient as BrokerGhClient } from "./gh-client.js";
import { runCandidateLoop } from "./candidate-loop.js";
import { RepoFilter } from "../core/repo-filter.js";

export interface DaemonCliOverrides {
  pollIntervalSec?: number;
  host?: string;
  logLevel?: string;
  httpPort?: number;
  // taskTimeoutSec is read today but not yet consumed; kept for Phase 3b.
  taskTimeoutSec?: number;
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
 * Recognised flags (all optional):
 *   --poll-interval-secs <n>
 *   --host <host>
 *   --log-level <level>
 *   --http-port <n>
 *   --task-timeout-secs <n>
 *
 * Unknown flags are dropped silently in Phase 3a — they'll be parsed by
 * the future full-featured daemon in 3b/3c. This keeps the skeleton
 * forward-compatible with existing Rust-backend invocations.
 */
export function parseDaemonArgs(argv: readonly string[]): DaemonCliOverrides {
  const overrides: DaemonCliOverrides = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string | undefined => argv[i + 1];
    const advance = (): void => {
      i += 1;
    };
    switch (arg) {
      case "--poll-interval-secs":
      case "--poll-interval-sec": {
        const value = next();
        if (value !== undefined) {
          const n = Number.parseInt(value, 10);
          if (Number.isFinite(n) && n > 0) overrides.pollIntervalSec = n;
          advance();
        }
        break;
      }
      case "--host": {
        const value = next();
        if (value !== undefined) {
          overrides.host = value;
          advance();
        }
        break;
      }
      case "--log-level": {
        const value = next();
        if (value !== undefined) {
          overrides.logLevel = value;
          advance();
        }
        break;
      }
      case "--http-port": {
        const value = next();
        if (value !== undefined) {
          const n = Number.parseInt(value, 10);
          if (Number.isFinite(n) && n > 0 && n < 65_536) {
            overrides.httpPort = n;
          }
          advance();
        }
        break;
      }
      case "--task-timeout-secs":
      case "--task-timeout-sec": {
        const value = next();
        if (value !== undefined) {
          const n = Number.parseInt(value, 10);
          if (Number.isFinite(n) && n > 0) overrides.taskTimeoutSec = n;
          advance();
        }
        break;
      }
      default:
        // Forward-compat: ignore unknown flags in 3a.
        break;
    }
  }
  return overrides;
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

  let config: DaemonConfig;
  try {
    config = loadBreezeDaemonConfig({ cliOverrides });
  } catch (err) {
    logger.error(
      `failed to load daemon config: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const paths = resolveBreezePaths();

  // Identity resolution is best-effort at startup. The daemon will still
  // try to poll if identity fails — the poller uses the host-only env,
  // not the login. But we log loudly so operators notice.
  try {
    const identity = resolveDaemonIdentity({ host: config.host });
    if (!identityHasRequiredScope(identity)) {
      logger.warn(
        `gh token for ${identity.login}@${identity.host} lacks \`repo\`/\`notifications\` scope; poll may return empty results`,
      );
    } else {
      logger.info(
        `breeze daemon: identity=${identity.login}@${identity.host}`,
      );
    }
  } catch (err) {
    logger.warn(
      `identity resolution failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Wire abort cascade. Tests may pass a pre-built signal directly.
  const controller = new AbortController();
  let uninstallHandlers: (() => void) | null = null;
  const installHandlers = options.installSignalHandlers ?? true;
  if (installHandlers) {
    uninstallHandlers = installShutdownHandlers(controller, logger);
  }
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
  }

  logger.info(
    `breeze daemon: poll-interval=${config.pollIntervalSec}s host=${config.host} http-port=${config.httpPort}`,
  );

  // Phase 3c: shared in-process bus drives SSE + broker task events.
  const bus = createBus({
    onListenerError: (err) =>
      logger.warn(
        `bus listener threw: ${err instanceof Error ? err.message : String(err)}`,
      ),
  });

  // Phase 3c: start gh broker + dispatcher if runners are available.
  // Absence of codex/claude is non-fatal; the daemon still runs as
  // read-only (poller + http).
  let broker: RunningBroker | null = null;
  let dispatcher: Dispatcher | null = null;
  let candidateLoopDone: Promise<void> | null = null;
  try {
    const runners = detectAvailableRunners();
    const realGh = findExecutable("gh");
    if (runners.length > 0 && realGh) {
      const runnerHome = resolveRunnerHome();
      const brokerDir = join(runnerHome, "broker");
      const identity = resolveDaemonIdentity({ host: config.host });
      const executor = new GhExecutor({
        realGh,
        writeCooldownMs: 1_000,
        signal: controller.signal,
      });
      broker = await startGhBroker({
        brokerDir,
        executor,
        logger: {
          warn: (line) => logger.warn(`broker: ${line}`),
          error: (line) => logger.error(`broker: ${line}`),
        },
      });
      const workspaceManager = new WorkspaceManager({
        reposDir: join(runnerHome, "repos"),
        workspacesDir: join(runnerHome, "workspaces"),
        identity: { host: identity.host, login: identity.login },
      });
      dispatcher = new Dispatcher({
        runnerHome,
        identity: { host: identity.host, login: identity.login },
        runners,
        workspaceManager,
        bus,
        ghShimDir: broker.shimDir,
        ghBrokerDir: broker.brokerDir,
        claimsDir: paths.claimsDir,
        disclosureText:
          "This reply was drafted by breeze, an autonomous agent running on behalf of the account owner.",
        maxParallel: 2,
        taskTimeoutMs: config.taskTimeoutSec * 1_000,
        logger,
      });
      logger.info(
        `breeze daemon: dispatcher ready (runners=${runners.map((r) => r.kind).join(",")}, broker=${broker.shimDir})`,
      );

      // Phase 4: candidate loop — feeds the dispatcher from GitHub.
      const candidateClient = new BrokerGhClient({
        host: identity.host,
        repoFilter: RepoFilter.empty(),
        executor,
      });
      candidateLoopDone = runCandidateLoop({
        client: candidateClient,
        dispatcher,
        bus,
        pollIntervalSec: config.pollIntervalSec,
        searchLimit: 10,
        includeSearch: true,
        lookbackSecs: 24 * 3_600,
        signal: controller.signal,
        logger,
      }).catch((err) => {
        logger.error(
          `candidate loop crashed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } else {
      const missing: string[] = [];
      if (runners.length === 0) missing.push("no codex/claude on PATH");
      if (!realGh) missing.push("no gh on PATH");
      logger.warn(
        `breeze daemon: skipping broker/dispatcher (${missing.join("; ")})`,
      );
    }
  } catch (err) {
    logger.error(
      `failed to start broker/dispatcher: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Continue without dispatcher; still run poller + http.
  }

  // Phase 3b: start the read-only HTTP + SSE server.
  // If the shared controller is already aborted (tests inject a
  // pre-aborted signal; real SIGTERM arrives later), skip binding: we
  // would close immediately anyway and we'd rather not touch the
  // listener table in fast-exit paths.
  let httpServer: RunningHttpServer | null = null;
  if (!controller.signal.aborted) {
    try {
      httpServer = await startHttpServer({
        httpPort: config.httpPort,
        inboxPath: paths.inbox,
        activityLogPath: paths.activityLog,
        bus: toSseBus(bus),
        signal: controller.signal,
        logger,
      });
    } catch (err) {
      logger.error(
        `failed to start http server: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (dispatcher) await dispatcher.stop();
      if (broker) await broker.stop();
      if (uninstallHandlers) uninstallHandlers();
      return 1;
    }
  }

  let exitCode = 0;
  try {
    await runPoller({
      pollIntervalSec: config.pollIntervalSec,
      host: config.host,
      paths,
      signal: controller.signal,
      logger,
    });
  } catch (err) {
    logger.error(
      `poller exited with error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
    );
    exitCode = 1;
  } finally {
    // Shutdown order:
    //   SIGTERM -> stop poller (above) -> flush store (poller's atomic
    //   tmp+rename drains in updateInbox) -> stop dispatcher (aborts
    //   in-flight runner tasks) -> stop broker (drains serve loop) ->
    //   stop http -> close bus -> exit.
    if (!controller.signal.aborted) controller.abort();
    if (candidateLoopDone) {
      try {
        await candidateLoopDone;
      } catch (err) {
        logger.warn(
          `candidate loop shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (dispatcher) {
      try {
        await dispatcher.stop();
      } catch (err) {
        logger.warn(
          `dispatcher shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (broker) {
      try {
        await broker.stop();
      } catch (err) {
        logger.warn(
          `broker shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (httpServer) {
      try {
        await httpServer.done;
      } catch (err) {
        logger.warn(
          `http server shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    bus.close();
    if (uninstallHandlers) uninstallHandlers();
  }

  logger.info("breeze daemon: shutdown complete");
  return exitCode;
}

/**
 * Walk PATH looking for a best-effort set of agent binaries. Returns
 * the specs in the order we'd prefer as the primary runner. Missing
 * binaries are silently omitted — the caller decides whether that is
 * fatal.
 */
export function detectAvailableRunners(): RunnerSpec[] {
  const runners: RunnerSpec[] = [];
  if (findExecutable("codex")) runners.push({ kind: "codex" });
  if (findExecutable("claude")) runners.push({ kind: "claude" });
  return runners;
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
 * `$BREEZE_HOME` or `$BREEZE_DIR/runner`, defaulting to
 * `~/.breeze/runner`. Matches `resolve_inbox_dir` in Rust `fetcher.rs`.
 */
export function resolveRunnerHome(
  env: (name: string) => string | undefined = (n) => process.env[n],
): string {
  const breezeHome = env("BREEZE_HOME");
  if (breezeHome && breezeHome.length > 0) return breezeHome;
  const breezeDir = env("BREEZE_DIR");
  if (breezeDir && breezeDir.length > 0) return join(breezeDir, "runner");
  return join(homedir(), ".breeze", "runner");
}

export default runDaemon;
