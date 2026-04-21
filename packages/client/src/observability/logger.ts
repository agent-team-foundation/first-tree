import {
  createLoggerOutputStream,
  formatLocalTime,
  type LogFormat,
  type LogLevel,
  parseLogLevel,
} from "@agent-team-foundation/first-tree-hub-shared/observability";
import pino from "pino";

/**
 * Client-side logger. Same pretty / NDJSON formats as the server logger, but
 * intentionally lightweight — the client is deployed to agent user machines,
 * so we skip tracing, context propagation, and error sinks.
 */

const initialLevel = parseLogLevel(process.env.FIRST_TREE_HUB_LOG_LEVEL);
let _format: LogFormat = process.env.NODE_ENV === "production" ? "json" : "pretty";
let _level: LogLevel = initialLevel.level;

export function applyClientLoggerConfig(options: { level?: LogLevel; format?: LogFormat } = {}): void {
  if (options.level) {
    _level = options.level;
    rootLogger.level = options.level;
  }
  if (options.format) _format = options.format;
}

const outputStream = createLoggerOutputStream({ getFormat: () => _format });

export const rootLogger = pino(
  {
    level: _level,
    timestamp: () => `,"time":"${formatLocalTime()}"`,
  },
  outputStream,
);

if (initialLevel.fellBack) {
  rootLogger.warn(
    { envValue: process.env.FIRST_TREE_HUB_LOG_LEVEL },
    "invalid FIRST_TREE_HUB_LOG_LEVEL; falling back to info",
  );
}

export function createLogger(module: string): pino.Logger {
  return rootLogger.child({ module });
}
