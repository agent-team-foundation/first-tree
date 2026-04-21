/**
 * Logger core — format / level primitives shared between server and client.
 *
 * This module intentionally has no dependency on `pino` so it can live in
 * `@agent-team-foundation/first-tree-hub-shared`. Consumers construct their
 * own pino instance and pass the output stream built here.
 */

import { Writable } from "node:stream";
import { z } from "zod";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_FORMATS = ["pretty", "json"] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

export const logLevelSchema = z.enum(LOG_LEVELS);
export const logFormatSchema = z.enum(LOG_FORMATS);

/**
 * Parse an env-var / config string into a LogLevel. Unknown values fall back
 * to `info` so the process never fails to boot on a typo — the caller is
 * responsible for emitting a warning when `fellBack` is true.
 */
export function parseLogLevel(raw: string | undefined | null): { level: LogLevel; fellBack: boolean } {
  if (!raw) return { level: "info", fellBack: false };
  const parsed = logLevelSchema.safeParse(raw);
  if (parsed.success) return { level: parsed.data, fellBack: false };
  return { level: "info", fellBack: true };
}

// ─── Pretty formatter ─────────────────────────────────────────────────

export const LEVEL_LABELS: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

export const LEVEL_COLORS: Record<number, string> = {
  10: "\x1b[90m",
  20: "\x1b[36m",
  30: "\x1b[32m",
  40: "\x1b[33m",
  50: "\x1b[31m",
  60: "\x1b[35m",
};

export const RESET = "\x1b[0m";
export const DIM = "\x1b[2m";

export const SKIP_KEYS = new Set(["level", "time", "msg", "module", "pid", "hostname", "v"]);

export function formatPrettyEntry(json: string): string {
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

export function formatLocalTime(): string {
  const d = new Date();
  const date = d.toLocaleDateString("sv-SE");
  const time = d.toLocaleTimeString("en-GB", { hour12: false });
  return `${date} ${time}`;
}

// ─── Output stream factory ────────────────────────────────────────────

type CreateStreamOptions = {
  /** Getter so the format can change via applyConfig without rebuilding the stream. */
  getFormat: () => LogFormat;
  /**
   * Optional hook invoked once per NDJSON record written by pino. Server uses
   * this to bridge error/fatal logs onto the active OTel span; client leaves
   * it undefined.
   */
  onJsonEntry?: (obj: Record<string, unknown>) => void;
};

export function createLoggerOutputStream(options: CreateStreamOptions): Writable {
  return new Writable({
    write(chunk, _, callback) {
      const text = chunk.toString();
      try {
        if (options.getFormat() === "pretty") {
          process.stdout.write(formatPrettyEntry(text));
        } else {
          process.stdout.write(text);
        }
        if (options.onJsonEntry) {
          try {
            const obj = JSON.parse(text) as Record<string, unknown>;
            options.onJsonEntry(obj);
          } catch {
            // non-JSON line, ignore
          }
        }
      } catch {
        process.stdout.write(text);
      }
      callback();
    },
  });
}
