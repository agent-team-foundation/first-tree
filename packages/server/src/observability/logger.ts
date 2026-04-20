import { Writable } from "node:stream";
import pino from "pino";

// ─── Config (late-initialized) ────────────────────────────────────────

type LogFormat = "pretty" | "json";
type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

let _format: LogFormat = process.env.NODE_ENV === "production" ? "json" : "pretty";
let _level: LogLevel = ((process.env.FIRST_TREE_HUB_LOG_LEVEL as LogLevel | undefined) ?? "info") as LogLevel;
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

// ─── Pretty formatter ─────────────────────────────────────────────────

const LEVEL_LABELS: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

const LEVEL_COLORS: Record<number, string> = {
  10: "\x1b[90m",
  20: "\x1b[36m",
  30: "\x1b[32m",
  40: "\x1b[33m",
  50: "\x1b[31m",
  60: "\x1b[35m",
};

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const SKIP_KEYS = new Set(["level", "time", "msg", "module", "pid", "hostname", "v"]);

function formatPrettyEntry(json: string): string {
  const obj = JSON.parse(json) as Record<string, unknown>;
  const level = obj.level as number;
  const label = LEVEL_LABELS[level] ?? "???";
  const color = LEVEL_COLORS[level] ?? "";
  const time = (obj.time as string) ?? new Date().toISOString();
  const module = obj.module ? `[${String(obj.module)}] ` : "";
  const msg = (obj.msg as string) ?? "";

  const extras: string[] = [];
  let errStack = "";
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP_KEYS.has(k)) continue;
    if (k === "err" && v && typeof v === "object") {
      const e = v as Record<string, unknown>;
      if (e.message) extras.push(`err.message=${String(e.message)}`);
      if (typeof e.stack === "string") errStack = `\n${DIM}${e.stack}${RESET}`;
    } else {
      extras.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
  }

  const extraStr = extras.length > 0 ? `  ${DIM}${extras.join(" ")}${RESET}` : "";
  return `${DIM}${time}${RESET} ${color}${label.padEnd(5)}${RESET} ${module}${msg}${extraStr}${errStack}\n`;
}

function formatLocalTime(): string {
  const d = new Date();
  const date = d.toLocaleDateString("sv-SE");
  const time = d.toLocaleTimeString("en-GB", { hour12: false });
  return `${date} ${time}`;
}

// ─── Error sink (bridges error/fatal logs onto active span) ───────────

type ErrorSink = (message: string, err: unknown, context: Record<string, unknown>) => void;
let _errorSink: ErrorSink | null = null;

export function setErrorSink(sink: ErrorSink | null): void {
  _errorSink = sink;
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
    context[k] = v;
  }
  if (typeof obj.module === "string") context.module = obj.module;
  try {
    _errorSink(msg, errField, context);
  } catch {
    // sink errors must not break the logging path
  }
}

// ─── Output stream ────────────────────────────────────────────────────

const outputStream = new Writable({
  write(chunk, _, callback) {
    const text = chunk.toString();
    try {
      if (_format === "pretty") {
        process.stdout.write(formatPrettyEntry(text));
      } else {
        process.stdout.write(text);
      }
      try {
        const obj = JSON.parse(text) as Record<string, unknown>;
        forwardErrorIfNeeded(obj);
      } catch {
        // non-JSON line, ignore
      }
    } catch {
      process.stdout.write(text);
    }
    callback();
  },
});

// ─── Root logger ──────────────────────────────────────────────────────

export const rootLogger = pino(
  {
    level: _level,
    timestamp: () => `,"time":"${formatLocalTime()}"`,
  },
  outputStream,
);

/** Create a module-scoped child logger. Module name is shown as `[Module]` in pretty output. */
export function createLogger(module: string): pino.Logger {
  return rootLogger.child({ module });
}

export type { pino };
