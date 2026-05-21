import { join } from "node:path";
import type { Writable } from "node:stream";
import {
  createLoggerOutputStream,
  formatLocalTime,
  LOG_REDACT_CENSOR,
  LOG_REDACT_PATHS,
  type LogFormat,
  type LogLevel,
  parseLogLevel,
} from "@first-tree/shared/observability";
import pino from "pino";
import { RotatingFileStream } from "./rotating-file-stream.js";

/** Rotation defaults for the background service log file. */
const SERVICE_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const SERVICE_LOG_MAX_FILES = 7;

/**
 * Client-side logger. Same pretty / NDJSON formats as the server logger, but
 * intentionally lightweight — the client is deployed to agent user machines,
 * so we skip tracing, context propagation, and error sinks.
 */

const initialLevel = parseLogLevel(process.env.FIRST_TREE_LOG_LEVEL);
// Tests get a silent logger unless FIRST_TREE_LOG_LEVEL is explicitly set,
// otherwise vitest output would be flooded by runtime logs that happen to run
// during setup.
const initialPinoLevel: LogLevel | "silent" =
  process.env.NODE_ENV === "test" && !process.env.FIRST_TREE_LOG_LEVEL ? "silent" : initialLevel.level;
let _format: LogFormat = process.env.NODE_ENV === "production" ? "json" : "pretty";
let _destination: Writable = process.stderr;
// Tracks whether the level was pinned by an explicit operator decision (CLI
// `--verbose` / `--json`, or a test harness). Once pinned, later config-driven
// applies (e.g. `client start` reading `logLevel` from client.yaml) must not
// overwrite it.
let _levelExplicit = false;

export function applyClientLoggerConfig(
  options: { level?: LogLevel | "silent"; format?: LogFormat; destination?: Writable; explicit?: boolean } = {},
): void {
  // Tri-state: `explicit: true` pins, `explicit: false` un-pins, undefined
  // leaves the pin state alone.
  if (options.explicit === false) _levelExplicit = false;
  if (options.level !== undefined && (options.explicit === true || !_levelExplicit)) {
    rootLogger.level = options.level;
  }
  if (options.explicit === true) _levelExplicit = true;
  if (options.format) _format = options.format;
  if (options.destination) _destination = options.destination;
}

const outputStream = createLoggerOutputStream({
  getFormat: () => _format,
  getDestination: () => _destination,
});

export const rootLogger = pino(
  {
    level: initialPinoLevel,
    timestamp: () => `,"time":"${formatLocalTime()}"`,
    redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
  },
  outputStream,
);

if (initialLevel.fellBack) {
  rootLogger.warn(
    { envValue: process.env.FIRST_TREE_LOG_LEVEL },
    "invalid FIRST_TREE_LOG_LEVEL; falling back to info",
  );
}

export function createLogger(module: string): pino.Logger {
  return rootLogger.child({ module });
}

/**
 * Switch the client logger over to the background-service file sink.
 *
 * The launchd / systemd unit files already set `StandardOutPath` /
 * `StandardError` as a fallback for crash-time stderr; this routes normal
 * operational logs into a size-rotated NDJSON file at
 * `<logDir>/client.log` so it doesn't grow unbounded. Must be called once
 * at `client start` when running under `FIRST_TREE_SERVICE_MODE=1`.
 */
export function configureClientLoggerForService(logDir: string): void {
  const stream = new RotatingFileStream({
    path: join(logDir, "client.log"),
    maxBytes: SERVICE_LOG_MAX_BYTES,
    maxFiles: SERVICE_LOG_MAX_FILES,
  });
  // Pretty ANSI codes in a log file are noise; lock format to NDJSON. Tail with
  // `tail -f ~/.first-tree/hub/logs/client.log` and pipe through `jq` to format.
  applyClientLoggerConfig({ format: "json", destination: stream });
}

export type { pino };
