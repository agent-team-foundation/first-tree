/**
 * TS port of the string / id / timestamp helpers in
 * `util.rs`.
 *
 * Ported functions:
 *   - `fnv1a64` + `stable_file_id`    — deterministic 16-hex-char id
 *   - `canonical_api_path`            — strip `https://api.github.com` prefix
 *   - `parse_tsv_line` + `unescape_jq_field` — read `@tsv` jq output
 *   - `encode_multiline` / `decode_multiline` — escape `\n` in kv lines
 *   - `shell_quote`                   — POSIX single-quote-safe rendering
 *   - `parse_github_timestamp_epoch` / `is_recent_github_timestamp`
 *   - `parse_kv_lines`                — read `key=value\n` blocks
 *
 * All pure, no I/O.
 */

/** FNV-1a 64-bit hash (matches Rust `fnv1a64`). */
export function fnv1a64(value: string): bigint {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = (1n << 64n) - 1n;
  let hash = FNV_OFFSET;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash;
}

/** Lowercase 16-hex-char stable id derived from `fnv1a64`. */
export function stableFileId(value: string): string {
  const h = fnv1a64(value);
  return h.toString(16).padStart(16, "0");
}

/**
 * Strip the canonical GitHub prefix from a URL and trim trailing `/`.
 * Used to derive `thread_key` from an `api_url` (so the same thread
 * key is stable across the REST host and the web host).
 */
export function canonicalApiPath(url: string): string {
  const trimmed = url.trim();
  const stripped = trimmed.startsWith("https://api.github.com")
    ? trimmed.slice("https://api.github.com".length)
    : trimmed.startsWith("https://github.com")
      ? trimmed.slice("https://github.com".length)
      : trimmed;
  return stripped.trim().replace(/\/+$/, "");
}

/** Split a `\t`-separated line and unescape jq's `\n`/`\t`/`\\`/`\u00..`. */
export function parseTsvLine(line: string): string[] {
  return line.split("\t").map(unescapeJqField);
}

/**
 * Decode jq `@tsv` escapes: `\n` → newline, `\t` → tab, `\\` → backslash,
 * `\uXXXX` → code point, and anything else falls through literally.
 */
export function unescapeJqField(value: string): string {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (c !== "\\") {
      output += c;
      continue;
    }
    const next = value[i + 1];
    i += 1;
    switch (next) {
      case "n":
        output += "\n";
        break;
      case "r":
        output += "\r";
        break;
      case "t":
        output += "\t";
        break;
      case "\\":
        output += "\\";
        break;
      case "b":
        output += "\b";
        break;
      case "f":
        output += "\f";
        break;
      case "u": {
        const code = value.slice(i + 1, i + 5);
        i += 4;
        const n = Number.parseInt(code, 16);
        if (Number.isFinite(n)) output += String.fromCodePoint(n);
        break;
      }
      case undefined:
        return output;
      default:
        output += next;
        break;
    }
  }
  return output;
}

/** Replace literal newlines with `\n` (kv-file friendly). */
export function encodeMultiline(value: string): string {
  return value.replace(/\n/g, "\\n");
}

/** Inverse of `encodeMultiline`. */
export function decodeMultiline(value: string): string {
  return value.replace(/\\n/g, "\n");
}

const SHELL_SAFE = /^[A-Za-z0-9\-_.\/:=,@]+$/;

/**
 * POSIX-safe shell quoting (single-quote form). Empty string renders
 * as `''` so it stays a distinct argument. Mirrors Rust `shell_quote`.
 */
export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (SHELL_SAFE.test(value)) return value;
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

/** Parse a `key=value` block into a Map. Empty/invalid lines are skipped. */
export function parseKvLines(contents: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of contents.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.length === 0) continue;
    out.push([key, value]);
  }
  return out;
}

/**
 * Parse a `YYYY-MM-DDTHH:MM:SSZ` GitHub timestamp to unix epoch seconds.
 * Returns `undefined` on malformed input. Mirrors Rust `parse_github_timestamp_epoch`
 * which is also strict about format length and separators.
 */
export function parseGithubTimestampEpoch(value: string): number | undefined {
  if (value.length !== 20) return undefined;
  if (
    value[4] !== "-" ||
    value[7] !== "-" ||
    value[10] !== "T" ||
    value[13] !== ":" ||
    value[16] !== ":" ||
    value[19] !== "Z"
  ) {
    return undefined;
  }
  const year = Number.parseInt(value.slice(0, 4), 10);
  const month = Number.parseInt(value.slice(5, 7), 10);
  const day = Number.parseInt(value.slice(8, 10), 10);
  const hour = Number.parseInt(value.slice(11, 13), 10);
  const minute = Number.parseInt(value.slice(14, 16), 10);
  const second = Number.parseInt(value.slice(17, 19), 10);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return undefined;
  }
  if (month < 1 || month > 12) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor(ms / 1000);
}

/** True when `value` parses as a timestamp and lies within `lookbackSecs` of `nowEpoch`. */
export function isRecentGithubTimestamp(
  value: string,
  nowEpoch: number,
  lookbackSecs: number,
): boolean {
  const ts = parseGithubTimestampEpoch(value);
  if (ts === undefined) return false;
  return ts >= Math.max(0, nowEpoch - lookbackSecs);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}
