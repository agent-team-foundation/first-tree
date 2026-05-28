import { readFileSync } from "node:fs";
import { fail } from "../../../cli/output.js";

/**
 * Parse `--meta key=value` flags into a nested object, with support for
 * dotted paths (`options.mode=single`) and array index segments
 * (`options.items[0].label=batch`). Values are stored as strings by default;
 * `true` / `false` / numeric literals are coerced to their native types so
 * boolean / numeric metadata flags don't require shell quoting tricks.
 *
 * `mergeMetaJson` (called separately) layers a `--meta-json @file.json` blob
 * on top, intentionally overwriting flat `--meta` keys — the JSON file is the
 * escape hatch for shapes the flat syntax can't express, so it wins.
 */
export function parseMetaFlags(flags: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of flags) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      fail("INVALID_META", `Bad --meta value "${raw}". Expected "key=value" or "a.b.c=value".`, 2);
    }
    const path = raw.slice(0, eq);
    const value = coerceScalar(raw.slice(eq + 1));
    assignPath(out, parsePath(path), value);
  }
  return out;
}

/**
 * Read `--meta-json @file.json` (or inline JSON) and merge it over the flat
 * meta bag. The `@` prefix signals "read from file"; without it the value is
 * parsed as an inline JSON string.
 */
export function mergeMetaJson(base: Record<string, unknown>, raw: string | undefined): Record<string, unknown> {
  if (!raw) return base;
  let text: string;
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    try {
      text = readFileSync(path, "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail("META_JSON_READ_FAILED", `Could not read --meta-json file "${path}": ${msg}`, 2);
    }
  } else {
    text = raw;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail("META_JSON_INVALID", `--meta-json content is not valid JSON: ${msg}`, 2);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("META_JSON_NOT_OBJECT", "--meta-json must decode to a JSON object.", 2);
  }
  return { ...base, ...(parsed as Record<string, unknown>) };
}

type Segment = { kind: "key"; key: string } | { kind: "index"; index: number };

function parsePath(path: string): Segment[] {
  const segments: Segment[] = [];
  // Split on `.`, then peel off `[N]` suffixes from each part so
  // `items[0]` resolves to ("items"[key], 0[index]).
  for (const part of path.split(".")) {
    if (part.length === 0) {
      fail("INVALID_META_PATH", `Empty path segment in "${path}".`, 2);
    }
    const match = /^([^[]+)((?:\[\d+\])*)$/.exec(part);
    if (!match || match[1] === undefined) {
      fail("INVALID_META_PATH", `Cannot parse path segment "${part}" in "${path}".`, 2);
    }
    segments.push({ kind: "key", key: match[1] });
    const trailing = match[2] ?? "";
    if (trailing.length > 0) {
      const indexMatches = trailing.matchAll(/\[(\d+)\]/g);
      for (const m of indexMatches) {
        const raw = m[1];
        if (raw === undefined) continue;
        segments.push({ kind: "index", index: Number.parseInt(raw, 10) });
      }
    }
  }
  return segments;
}

function assignPath(root: Record<string, unknown>, segments: Segment[], value: unknown): void {
  let cursor: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    const isLast = i === segments.length - 1;
    const next = segments[i + 1];
    if (seg.kind === "key") {
      if (Array.isArray(cursor)) {
        fail("INVALID_META_PATH", "Tried to descend into an array with a named key.", 2);
      }
      const obj = cursor;
      if (isLast) {
        obj[seg.key] = value;
        return;
      }
      const child = obj[seg.key];
      const expectArray = next !== undefined && next.kind === "index";
      if (child === undefined || child === null) {
        const created: Record<string, unknown> | unknown[] = expectArray ? [] : {};
        obj[seg.key] = created;
        cursor = created;
      } else if (expectArray && !Array.isArray(child)) {
        fail("INVALID_META_PATH", `Path collision at "${seg.key}": existing value is not an array.`, 2);
      } else if (!expectArray && (Array.isArray(child) || typeof child !== "object")) {
        fail("INVALID_META_PATH", `Path collision at "${seg.key}": existing value is not an object.`, 2);
      } else {
        cursor = child as Record<string, unknown> | unknown[];
      }
    } else {
      if (!Array.isArray(cursor)) {
        fail("INVALID_META_PATH", "Tried to index a non-array with [N].", 2);
      }
      const arr = cursor;
      if (isLast) {
        arr[seg.index] = value;
        return;
      }
      const child = arr[seg.index];
      const expectArray = next !== undefined && next.kind === "index";
      if (child === undefined || child === null) {
        const created: Record<string, unknown> | unknown[] = expectArray ? [] : {};
        arr[seg.index] = created;
        cursor = created;
      } else if (expectArray && !Array.isArray(child)) {
        fail("INVALID_META_PATH", `Path collision at [${seg.index}]: existing value is not an array.`, 2);
      } else if (!expectArray && (Array.isArray(child) || typeof child !== "object")) {
        fail("INVALID_META_PATH", `Path collision at [${seg.index}]: existing value is not an object.`, 2);
      } else {
        cursor = child as Record<string, unknown> | unknown[];
      }
    }
  }
}

function coerceScalar(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw !== "" && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

/**
 * Collector for repeated `--meta key=value` flags. Pass as the third argument
 * to `Command.option` so commander accumulates each occurrence into an array.
 */
export function collectMeta(value: string, previous: string[]): string[] {
  return [...previous, value];
}
