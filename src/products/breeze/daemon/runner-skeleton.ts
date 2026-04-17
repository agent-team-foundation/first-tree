/**
 * Minimal TS daemon entrypoint.
 *
 * This is Phase 3a: read-path only. The daemon spins up the notification
 * poller and waits for a shutdown signal. HTTP, broker, bus, dispatcher
 * are deferred to Phase 3b/3c — this skeleton explicitly leaves those
 * wiring points as TODOs so reviewers can see the future surface.
 *
 * Launch path:
 *   `first-tree breeze daemon --backend=ts`
 * delegates here via `src/products/breeze/cli.ts`. The `rust` backend
 * (default in Phase 3a) continues to route through
 * `bridge.ts::resolveBreezeRunner` and the Rust `breeze-runner` binary;
 * nothing in this file touches that path.
 *
 * Shutdown contract:
 *   - SIGTERM / SIGINT cascade through a single AbortController.
 *   - The poller observes `signal.aborted`, finishes any in-flight
 *     `pollOnce` (including draining the inbox.json advisory lock),
 *     then resolves.
 *   - The daemon exits with code 0 on clean shutdown, 1 if the poller
 *     threw.
 */

import { resolveBreezePaths } from "../core/paths.js";
import { loadBreezeDaemonConfig, type DaemonConfig } from "../core/config.js";

import { resolveDaemonIdentity, identityHasRequiredScope } from "./identity.js";
import { startHttpServer, type RunningHttpServer } from "./http.js";
import { runPoller, type PollerLogger } from "./poller.js";

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

  // Phase 3b: start the read-only HTTP + SSE server.
  // Phase 3c will replace the inbox-mtime stub bus with the real
  // broker-driven in-process bus. The http layer itself does NOT need
  // to change when that lands.
  //
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
        signal: controller.signal,
        logger,
      });
    } catch (err) {
      logger.error(
        `failed to start http server: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (uninstallHandlers) uninstallHandlers();
      return 1;
    }
  }
  // TODO(Phase 3c): start broker gh-serializer + bus + dispatcher.

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
    // Shutdown order (pinned by Phase 3a contract):
    //   SIGTERM -> stop poller (above) -> flush store (poller's atomic
    //   tmp+rename drains in updateInbox) -> stop http -> exit.
    if (httpServer) {
      try {
        // Ensure the shared controller is aborted so liveStreams cancel
        // even if we got here via an exception rather than SIGTERM.
        if (!controller.signal.aborted) controller.abort();
        await httpServer.done;
      } catch (err) {
        logger.warn(
          `http server shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (uninstallHandlers) uninstallHandlers();
  }

  logger.info("breeze daemon: shutdown complete");
  return exitCode;
}

export default runDaemon;
