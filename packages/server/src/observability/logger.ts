import {
  createLoggerOutputStream,
  formatLocalTime,
  LOG_REDACT_CENSOR,
  LOG_REDACT_PATHS,
  type LogFormat,
  type LogLevel,
  parseLogLevel,
  redactUrl,
  SKIP_KEYS,
} from "@first-tree/shared/observability";
import pino from "pino";

// ─── Config (late-initialized) ────────────────────────────────────────

const initialLevel = parseLogLevel(process.env.FIRST_TREE_LOG_LEVEL);
let _format: LogFormat = process.env.NODE_ENV === "production" ? "json" : "pretty";
let _level: LogLevel = initialLevel.level;
let _bridgeMinLevel = 50; // error

/**
 * Apply resolved logging config to the singleton pino instance. Must be called
 * once after `initConfig` and before any substantive logging happens. Loggers
 * already created via `createLogger` keep working — child loggers share the
 * root's level, which is updated here.
 */
export function applyLoggerConfig(options: {
  level: LogLevel;
  format: LogFormat;
  bridgeToSpanLevel: "error" | "warn" | "off";
}): void {
  _level = options.level;
  _format = options.format;
  _bridgeMinLevel =
    options.bridgeToSpanLevel === "off" ? Number.POSITIVE_INFINITY : options.bridgeToSpanLevel === "warn" ? 40 : 50;
  rootLogger.level = options.level;
}

// ─── Error sink (bridges error/fatal logs onto active span) ───────────

type ErrorSink = (message: string, err: unknown, context: Record<string, unknown>) => void;
let _errorSink: ErrorSink | null = null;

export function setErrorSink(sink: ErrorSink | null): void {
  _errorSink = sink;
}

/**
 * Truncate values before handing them to the sink. Strings over ~2KB get
 * clipped with a marker; objects are JSON-stringified then clipped. Prevents
 * an accidental 10MB log payload from becoming a 10MB span attribute.
 */
const MAX_STRING_LEN = 2048;
const MAX_JSON_LEN = 8192;

function truncateForAttr(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_LEN) return value;
    return `${value.slice(0, MAX_STRING_LEN)}...[truncated ${value.length - MAX_STRING_LEN} chars]`;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((x) => typeof x === "string")) return value;
  try {
    const json = JSON.stringify(value);
    if (!json) return undefined;
    if (json.length <= MAX_JSON_LEN) return json;
    return `${json.slice(0, MAX_JSON_LEN)}...[truncated ${json.length - MAX_JSON_LEN} chars]`;
  } catch {
    return String(value);
  }
}

function forwardErrorIfNeeded(obj: Record<string, unknown>): void {
  if (!_errorSink) return;
  const level = obj.level as number;
  if (level < _bridgeMinLevel) return;
  const msg = typeof obj.msg === "string" ? obj.msg : "error";
  const errField = obj.err;
  const context: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP_KEYS.has(k) || k === "err") continue;
    const truncated = truncateForAttr(v);
    if (truncated !== undefined) context[k] = truncated;
  }
  if (typeof obj.module === "string") context.module = obj.module;
  try {
    _errorSink(msg, errField, context);
  } catch {
    // sink errors must not break the logging path
  }
}

// ─── Root logger ──────────────────────────────────────────────────────

const outputStream = createLoggerOutputStream({
  getFormat: () => _format,
  onJsonEntry: forwardErrorIfNeeded,
});

/**
 * Custom `req` serializer that scrubs sensitive query-parameter values from
 * the URL before it lands in `incoming request` log lines. Admin WebSocket
 * credentials now travel only in the post-upgrade auth frame, but query
 * capabilities and legacy callers must still never leak into log files or
 * log shippers.
 *
 * Pino stores serializers under a Symbol; fastify's `createPinoLogger` picks
 * them up via `prevLogger[serializersSym]` and merges them into the per-
 * request child logger, overriding fastify's built-in `req` serializer.
 *
 * Field shape mirrors fastify's default serializer (see
 * `node_modules/fastify/lib/logger-pino.js`) so log consumers don't break.
 */
type IncomingReqLike = {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
};

function reqSerializer(req: IncomingReqLike): Record<string, unknown> {
  const acceptVersion = req.headers?.["accept-version"];
  return {
    method: req.method,
    url: typeof req.url === "string" ? redactUrl(req.url) : req.url,
    version: acceptVersion,
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

export const rootLogger = pino(
  {
    level: _level,
    timestamp: () => `,"time":"${formatLocalTime()}"`,
    redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
    serializers: { req: reqSerializer },
  },
  outputStream,
);

if (initialLevel.fellBack) {
  rootLogger.warn({ envValue: process.env.FIRST_TREE_LOG_LEVEL }, "invalid FIRST_TREE_LOG_LEVEL; falling back to info");
}

/** Create a module-scoped child logger. Module name is shown as `[Module]` in pretty output. */
export function createLogger(module: string): pino.Logger {
  return rootLogger.child({ module });
}

export type { pino };
