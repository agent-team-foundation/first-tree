import { Writable } from "node:stream";
import pino from "pino";

/**
 * Client-side logger. Same pretty / NDJSON formats as the server logger, but
 * intentionally lightweight — the client is deployed to agent user machines,
 * so we skip tracing, context propagation, and error sinks.
 */

type LogFormat = "pretty" | "json";
type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

let _format: LogFormat = process.env.NODE_ENV === "production" ? "json" : "pretty";
let _level: LogLevel = ((process.env.FIRST_TREE_HUB_LOG_LEVEL as LogLevel | undefined) ?? "info") as LogLevel;

export function applyClientLoggerConfig(options: { level?: LogLevel; format?: LogFormat } = {}): void {
  if (options.level) {
    _level = options.level;
    rootLogger.level = options.level;
  }
  if (options.format) _format = options.format;
}

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

function formatPretty(json: string): string {
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

function localTime(): string {
  const d = new Date();
  const date = d.toLocaleDateString("sv-SE");
  const time = d.toLocaleTimeString("en-GB", { hour12: false });
  return `${date} ${time}`;
}

const outputStream = new Writable({
  write(chunk, _, callback) {
    const text = chunk.toString();
    try {
      process.stdout.write(_format === "pretty" ? formatPretty(text) : text);
    } catch {
      process.stdout.write(text);
    }
    callback();
  },
});

export const rootLogger = pino(
  {
    level: _level,
    timestamp: () => `,"time":"${localTime()}"`,
  },
  outputStream,
);

export function createLogger(module: string): pino.Logger {
  return rootLogger.child({ module });
}
