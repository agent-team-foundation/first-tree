import { createReadStream, existsSync, statSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DEFAULT_HOME_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";
import {
  formatPrettyEntry,
  LOG_LEVELS,
  type LogLevel,
  parseLogLevel,
} from "@agent-team-foundation/first-tree-hub-shared/observability";
import { print } from "./output.js";

const LOG_DIR = join(DEFAULT_HOME_DIR, "logs");
const PRIMARY_LOG = join(LOG_DIR, "client.log");
// Supervisor (launchd / systemd) writes raw stdout/stderr here as a fallback,
// capturing crash output that happens before pino takes over the stream, plus
// anything third-party code writes to stderr directly. Operators need these
// when diagnosing startup failures, so surface them alongside client.log.
const FALLBACK_STDOUT = join(LOG_DIR, "client.stdout.log");
const FALLBACK_STDERR = join(LOG_DIR, "client.stderr.log");

/**
 * Duration string → milliseconds. Accepts `10s`, `5m`, `2h`, `1d`; rejects
 * everything else. Keeps the parser tiny rather than pulling in a library —
 * the `--since` flag is the only consumer.
 */
export function parseDuration(input: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(input.trim());
  if (!match) {
    throw new Error(`invalid duration "${input}" (expected e.g. 30s, 5m, 2h, 1d)`);
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * (multipliers[unit as string] ?? 0);
}

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** Rotated log files, newest-first. Missing files are silently skipped. */
export function listLogFilesNewestFirst(): string[] {
  const files: string[] = [];
  if (existsSync(PRIMARY_LOG)) files.push(PRIMARY_LOG);
  // Rotated files `.1`, `.2`, … are older as the index grows; rotation
  // produces contiguous numbering, so the first miss means there are no more.
  for (let i = 1; ; i++) {
    const p = `${PRIMARY_LOG}.${i}`;
    if (!existsSync(p)) break;
    files.push(p);
  }
  return files;
}

/** Supervisor fallback files (raw stdout/stderr, not NDJSON). Missing files skipped. */
export function listFallbackFiles(): string[] {
  const files: string[] = [];
  if (existsSync(FALLBACK_STDERR)) files.push(FALLBACK_STDERR);
  if (existsSync(FALLBACK_STDOUT)) files.push(FALLBACK_STDOUT);
  return files;
}

export type ServiceLogsOptions = {
  /** If true, keep the stream open and print new lines as they arrive. */
  tail: boolean;
  /** Only show records with level >= this. Undefined = no filter. */
  level?: LogLevel;
  /** Only show records newer than this many milliseconds ago. */
  sinceMs?: number;
  /** Bypass pretty-printing; emit raw NDJSON lines to stdout. */
  json: boolean;
};

function matchesFilters(
  obj: Record<string, unknown>,
  minLevel: number | undefined,
  cutoffMs: number | undefined,
): boolean {
  if (minLevel !== undefined) {
    const lvl = typeof obj.level === "number" ? obj.level : Number.NaN;
    if (!Number.isFinite(lvl) || lvl < minLevel) return false;
  }
  if (cutoffMs !== undefined) {
    const t = parseLogTime(obj.time);
    if (t === null || t < cutoffMs) return false;
  }
  return true;
}

/** Logger writes `time` as a local-ish string (`YYYY-MM-DD HH:mm:ss`). */
function parseLogTime(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  // Local time formatter produces `YYYY-MM-DD HH:mm:ss` without tz offset.
  // Node `Date.parse` needs a `T` separator to treat it as an ISO-like local
  // timestamp; without it some platforms return NaN.
  const iso = value.replace(" ", "T");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function renderLine(line: string, json: boolean): string | null {
  if (!line.trim()) return null;
  if (json) return `${line}\n`;
  try {
    return formatPrettyEntry(line);
  } catch {
    return `${line}\n`;
  }
}

function processLogLine(
  line: string,
  minLevel: number | undefined,
  cutoffMs: number | undefined,
  json: boolean,
): string | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // Non-JSON lines survived from stderr fallbacks; pass them through in
    // pretty mode, drop them in `--json` mode where they'd corrupt NDJSON.
    return json ? null : `${line}\n`;
  }
  if (!matchesFilters(obj, minLevel, cutoffMs)) return null;
  return renderLine(line, json);
}

async function readFileLines(
  path: string,
  minLevel: number | undefined,
  cutoffMs: number | undefined,
  json: boolean,
): Promise<void> {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }) });
  for await (const line of rl) {
    const rendered = processLogLine(line, minLevel, cutoffMs, json);
    if (rendered) process.stdout.write(rendered);
  }
}

/**
 * Read a supervisor fallback file (launchd / systemd stdout/stderr capture).
 * These are plain text, not NDJSON: level and time filters don't apply, so we
 * honour `--since` by dropping the whole file when its mtime predates the
 * cutoff and otherwise pass every line through. In pretty mode each line is
 * tagged with the source so operators can tell it apart from pino output; in
 * `--json` mode we emit a synthetic record so NDJSON consumers keep one
 * object per line.
 */
async function readFallbackFile(path: string, cutoffMs: number | undefined, json: boolean): Promise<void> {
  try {
    const mtime = statSync(path).mtimeMs;
    if (cutoffMs !== undefined && mtime < cutoffMs) return;
  } catch {
    return;
  }
  const source = path.endsWith(".stderr.log") ? "supervisor:stderr" : "supervisor:stdout";
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (json) {
      process.stdout.write(`${JSON.stringify({ source, line })}\n`);
    } else {
      process.stdout.write(`[${source}] ${line}\n`);
    }
  }
}

/**
 * Print existing log history, applying filters. `--tail` then switches to
 * follow mode and keeps printing new lines as the active file grows; rotation
 * is not handled during the tail (a follow-up rotation will simply stop
 * emitting new lines — operator can re-run the command).
 */
export async function showServiceLogs(options: ServiceLogsOptions): Promise<void> {
  if (!existsSync(LOG_DIR)) {
    print.status("logs", `directory not found: ${LOG_DIR}`);
    return;
  }

  const minLevel = options.level ? LEVEL_RANK[options.level] : undefined;
  const cutoffMs = options.sinceMs !== undefined ? Date.now() - options.sinceMs : undefined;

  // Supervisor fallback files capture pre-pino bootstrap output and crash
  // dumps — effectively the oldest context, so walk them first.
  for (const f of listFallbackFiles()) {
    await readFallbackFile(f, cutoffMs, options.json);
  }

  // Historical read: oldest-first so the terminal shows them in chronological
  // order. listLogFilesNewestFirst returns active file + `.1` (newest rotated)
  // + `.2` (older rotated) etc., so we reverse to walk oldest → newest.
  const files = listLogFilesNewestFirst().reverse();
  for (const f of files) {
    await readFileLines(f, minLevel, cutoffMs, options.json);
  }

  if (!options.tail) return;
  if (!existsSync(PRIMARY_LOG)) {
    // Nothing to tail yet; wait for it to appear.
    print.status("tail", "waiting for client.log to appear...");
  }

  await new Promise<void>((resolve) => {
    let position = existsSync(PRIMARY_LOG) ? statSync(PRIMARY_LOG).size : 0;
    const onChange = () => {
      if (!existsSync(PRIMARY_LOG)) return;
      const current = statSync(PRIMARY_LOG).size;
      if (current < position) {
        // Rotation happened — the writer moved our file to client.log.1 and
        // opened a fresh client.log. Start reading the new file from 0.
        position = 0;
      }
      if (current <= position) return;
      const stream = createReadStream(PRIMARY_LOG, { start: position, end: current - 1, encoding: "utf8" });
      position = current;
      const rl = createInterface({ input: stream });
      rl.on("line", (line) => {
        const rendered = processLogLine(line, minLevel, cutoffMs, options.json);
        if (rendered) process.stdout.write(rendered);
      });
    };
    watchFile(PRIMARY_LOG, { interval: 500 }, onChange);
    process.once("SIGINT", () => {
      unwatchFile(PRIMARY_LOG, onChange);
      resolve();
    });
  });
}

/** Validated flag parsers the CLI layer can reuse without re-doing the work. */
export function validateLevel(value: string | undefined): LogLevel | undefined {
  if (value === undefined) return undefined;
  const parsed = parseLogLevel(value);
  if (parsed.fellBack) {
    throw new Error(`invalid --level "${value}" (expected one of ${LOG_LEVELS.join(", ")})`);
  }
  return parsed.level;
}
