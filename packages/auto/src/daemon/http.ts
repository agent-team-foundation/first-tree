/**
 * Phase 3b: TypeScript port of the auto daemon HTTP + SSE server.
 *
 * Source of truth: `http.rs` (384
 * lines). Contract pinned in the HTTP/SSE API contract (historical migration doc, now removed; see git history).
 *
 * READ-ONLY DISCIPLINE:
 * ---------------------
 * This module NEVER calls `runtime/store.ts` writers. The HTTP server is
 * strictly a reader: it passes through `~/.first-tree/auto/inbox.json`, tails
 * `~/.first-tree/auto/activity.log`, and publishes SSE events produced by an
 * upstream bus. The single-writer rule for `inbox.json` (spec doc 2
 * §1.3) is owned by the poller; HTTP read paths either `fs.readFile` the
 * on-disk JSON directly (so they always see the last atomic rename) or
 * subscribe to an in-process bus (Phase 3c).
 *
 * Zero-framework footprint: we use `node:http` directly so the bundle
 * stays dep-free. Headers, status line, and keep-alive cadence match the
 * Rust server byte-for-byte.
 *
 * Loopback-only bind: the Rust server rejects non-127.0.0.1 binds at
 * startup (`http.rs:28-32`). We preserve that invariant.
 *
 * Shutdown: honors an `AbortSignal`. On abort:
 *   1. Stop accepting new connections (`server.close`).
 *   2. Abort all live SSE connections via their per-connection signals.
 *   3. Resolve once the listener has fully closed.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { promises as fsp, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveAutoPackageRoot } from "../bridge.js";
import {
  createInboxMtimeBus,
  runSseStream,
  type SseBus,
} from "./sse.js";

/**
 * Routes matched against the path component after the query is stripped.
 * `/`, `/dashboard`, `/index.html` all map to `dashboard`, matching
 * `http.rs::parse_route`.
 */
export type Route =
  | "dashboard"
  | "healthz"
  | "inbox"
  | "activity"
  | "events"
  | "not-found";

export function parseRoute(method: string, url: string | undefined): Route {
  if (method !== "GET" || !url) return "not-found";
  const queryIdx = url.indexOf("?");
  const path = queryIdx === -1 ? url : url.slice(0, queryIdx);
  switch (path) {
    case "/":
    case "/dashboard":
    case "/index.html":
      return "dashboard";
    case "/healthz":
      return "healthz";
    case "/inbox":
      return "inbox";
    case "/activity":
      return "activity";
    case "/events":
      return "events";
    default:
      return "not-found";
  }
}

/** Hard-coded limit from `http.rs::write_activity_tail`. */
export const ACTIVITY_TAIL_LIMIT = 200;

/**
 * Port of `tail_as_json_array` (`http.rs:230-249`). Reads the file,
 * keeps the last `maxLines` non-empty lines, joins them with commas, and
 * wraps in `[...]`. Does NOT re-parse — matches Rust's pass-through.
 * Missing/unreadable file returns literal `"[]"` (200 OK).
 */
export function tailAsJsonArray(
  path: string,
  maxLines: number,
): string {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return "[]";
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const start = Math.max(0, lines.length - maxLines);
  const slice = lines.slice(start);
  return `[${slice.join(",")}]`;
}

/**
 * Resolve `assets/dashboard.html` relative to this module's package root.
 * Reuses `bridge.ts::resolveAutoPackageRoot` so the file ships whenever
 * the npm package is installed (it is listed in `package.json::files`).
 */
function resolveDashboardPath(startUrl: string = import.meta.url): string {
  return join(resolveAutoPackageRoot(startUrl), "assets", "dashboard.html");
}

let cachedDashboard: Buffer | null = null;

function loadDashboardHtml(override?: string): Buffer {
  if (override !== undefined) {
    return Buffer.from(override, "utf-8");
  }
  if (cachedDashboard !== null) return cachedDashboard;
  const path = resolveDashboardPath();
  cachedDashboard = readFileSync(path);
  return cachedDashboard;
}

/* ------------------------------------------------------------------ */
/* Response helpers — build bytes that match Rust's format! strings.  */
/* ------------------------------------------------------------------ */

/**
 * Plain-text response helper matching `write_plain` (`http.rs:170-185`).
 * Headers and order match the Rust output; status reason phrase is
 * `OK`/`Not Found`/empty per `reason_phrase`.
 */
export function writePlain(
  res: ServerResponse,
  status: number,
  body: string,
): void {
  res.writeHead(status, reasonPhrase(status), {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf-8"),
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(body);
}

function reasonPhrase(status: number): string {
  switch (status) {
    case 200:
      return "OK";
    case 404:
      return "Not Found";
    default:
      return "";
  }
}

function writeDashboard(res: ServerResponse, body: Buffer): void {
  res.writeHead(200, "OK", {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.byteLength,
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(body);
}

async function writeInboxJsonFile(
  res: ServerResponse,
  inboxPath: string,
): Promise<void> {
  let contents: string;
  try {
    contents = await fsp.readFile(inboxPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      writePlain(res, 404, "inbox.json not found\n");
      return;
    }
    writePlain(res, 404, "inbox.json not found\n");
    return;
  }
  res.writeHead(200, "OK", {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(contents, "utf-8"),
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(contents);
}

function writeActivityTail(
  res: ServerResponse,
  activityPath: string,
  maxLines: number,
): void {
  const body = tailAsJsonArray(activityPath, maxLines);
  res.writeHead(200, "OK", {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf-8"),
    "Cache-Control": "no-store",
    Connection: "close",
  });
  res.end(body);
}

function writeSseHeaders(res: ServerResponse): void {
  // Rust emits these headers explicitly (`http.rs:253-262`). No
  // Content-Length (indefinite stream); X-Accel-Buffering: no to
  // disable intermediate proxy buffering (nginx convention).
  res.writeHead(200, "OK", {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Flush the headers immediately so the client's EventSource gets the
  // 200 response without waiting for the first frame.
  if (typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
    (res as { flushHeaders: () => void }).flushHeaders();
  }
}

/* ------------------------------------------------------------------ */
/* Server lifecycle                                                    */
/* ------------------------------------------------------------------ */

export interface HttpLogger {
  info: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

export interface StartHttpServerOptions {
  /** Port to bind on 127.0.0.1. Default 7878. */
  httpPort: number;
  /** Path to `~/.first-tree/auto/inbox.json`. */
  inboxPath: string;
  /** Path to `~/.first-tree/auto/activity.log`. */
  activityLogPath: string;
  /** Shutdown signal. Server closes when this aborts. */
  signal: AbortSignal;
  /**
   * Event bus for SSE. If omitted, Phase 3b falls back to the inbox
   * mtime poller stub. Phase 3c will wire a real broker bus here.
   */
  bus?: SseBus;
  /** Logger for stderr-equivalent output. */
  logger?: HttpLogger;
  /** Override dashboard HTML (tests only). */
  dashboardHtml?: string;
  /** Keep-alive cadence in ms (tests pass shorter to speed up). */
  sseKeepAliveMs?: number;
}

export interface RunningHttpServer {
  /** The actual bound port (useful when the caller passes 0). */
  port: number;
  /**
   * Waits for the listener to close. Resolves after the abort signal
   * has fired AND all in-flight connections have drained.
   */
  done: Promise<void>;
  /** Explicit stop (idempotent). Equivalent to aborting the signal. */
  stop: () => Promise<void>;
}

const DEFAULT_LOGGER: HttpLogger = {
  info: (line) => process.stdout.write(`${line}\n`),
  warn: (line) => process.stderr.write(`WARN: ${line}\n`),
  error: (line) => process.stderr.write(`ERROR: ${line}\n`),
};

/**
 * Bind the HTTP server to `127.0.0.1:httpPort` and start serving.
 * Returns once the listener is actually bound; the caller awaits
 * `done` for shutdown.
 *
 * The server is single-writer-free: every route reads either from disk
 * (via `fs.promises`) or from the passed-in bus. Nothing here mutates
 * `~/.first-tree/auto`.
 */
export async function startHttpServer(
  options: StartHttpServerOptions,
): Promise<RunningHttpServer> {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const dashboardBody = loadDashboardHtml(options.dashboardHtml);

  // Phase 3b stub bus: inbox.json mtime poll at 1s. Phase 3c replaces
  // this with the real broker-driven bus.
  const bus =
    options.bus ??
    createInboxMtimeBus({
      inboxPath: options.inboxPath,
      signal: options.signal,
    });

  // Per-connection abort controllers keyed by response, so we can cancel
  // in-flight SSE streams on shutdown without leaking.
  const liveStreams = new Set<AbortController>();

  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const route = parseRoute(req.method ?? "GET", req.url);
      try {
        switch (route) {
          case "dashboard":
            writeDashboard(res, dashboardBody);
            return;
          case "healthz":
            writePlain(res, 200, "ok\n");
            return;
          case "inbox":
            void writeInboxJsonFile(res, options.inboxPath).catch((err) => {
              logger.error(
                `auto http: /inbox handler failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              if (!res.headersSent) writePlain(res, 404, "inbox.json not found\n");
            });
            return;
          case "activity":
            writeActivityTail(res, options.activityLogPath, ACTIVITY_TAIL_LIMIT);
            return;
          case "events": {
            writeSseHeaders(res);
            const streamController = new AbortController();
            liveStreams.add(streamController);
            // Link the server signal to this stream.
            const onServerAbort = (): void => streamController.abort();
            if (options.signal.aborted) streamController.abort();
            else options.signal.addEventListener("abort", onServerAbort, { once: true });
            runSseStream({
              response: res,
              bus,
              signal: streamController.signal,
              keepAliveMs: options.sseKeepAliveMs,
            })
              .catch((err) => {
                logger.warn(
                  `auto http: sse stream ended with error: ${err instanceof Error ? err.message : String(err)}`,
                );
              })
              .finally(() => {
                liveStreams.delete(streamController);
                options.signal.removeEventListener("abort", onServerAbort);
              });
            return;
          }
          case "not-found":
          default:
            writePlain(res, 404, "not found\n");
            return;
        }
      } catch (err) {
        logger.error(
          `auto http: handler crashed for ${req.method} ${req.url}: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (!res.headersSent) writePlain(res, 404, "not found\n");
      }
    },
  );

  // Prevent the HTTP listener from keeping the process alive after the
  // daemon's main shutdown has fired but before `server.close()` fully
  // drains — we still await `done` explicitly in `runDaemon`.
  server.on("clientError", (err) => {
    logger.warn(
      `auto http: client error: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(
        new Error(
          `failed to bind http server on 127.0.0.1:${options.httpPort}: ${err.message}`,
        ),
      );
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    // Loopback only — match `http.rs:28-32`. We never expose this to
    // non-localhost traffic; the dashboard is single-user by design.
    server.listen(options.httpPort, "127.0.0.1");
  });

  const address = server.address();
  const boundPort =
    typeof address === "object" && address !== null ? address.port : options.httpPort;
  logger.info(`auto: http server listening on http://127.0.0.1:${boundPort}`);

  let stopped = false;
  let resolveDone: () => void;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const close = (): void => {
    if (stopped) return;
    stopped = true;
    // Abort all in-flight SSE streams so the listener can actually
    // close. Without this, `server.close()` waits forever for
    // keep-alive connections.
    for (const controller of liveStreams) controller.abort();
    liveStreams.clear();
    server.close((err) => {
      if (err) {
        logger.warn(`auto http: server.close error: ${err.message}`);
      }
      resolveDone();
    });
  };
  if (options.signal.aborted) close();
  else options.signal.addEventListener("abort", close, { once: true });

  const stop = async (): Promise<void> => {
    close();
    await donePromise;
  };

  return {
    port: boundPort,
    done: donePromise,
    stop,
  };
}
