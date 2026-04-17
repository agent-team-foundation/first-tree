/**
 * Claude Code statusline hook.
 *
 * This file is its own dist bundle (`dist/breeze-statusline.js`). It is
 * called many times per session by the Claude Code harness, so cold start
 * MUST stay below ~30ms. To achieve that:
 *   - zero npm dependencies (only `node:fs`, `node:path`, `node:os`)
 *   - no `zod` / no `ink` / no `child_process`
 *   - hand-rolled field extraction so we never parse the whole inbox
 *     (common case: a few hundred notifications)
 *
 * Behaviour is a line-for-line port of `breeze-status`
 * +  `breeze-statusline-wrapper` (the wrapper just passes stdin through and
 * prints our output). Stdin is drained silently per the Claude Code
 * statusline contract.
 *
 * Input: swallow stdin (Claude Code statusline hooks receive JSON).
 * Output: a single line to stdout, e.g.
 *   `/breeze: ⚠ 2 need you · 52 PRs · 3 issues (+1 new)`
 * or nothing when the inbox is empty/missing.
 */

import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 10 minutes; matches `bin/breeze-status:25`. */
const STALE_THRESHOLD_SECS = 600;

function resolveBreezeDir(): string {
  const override = process.env.BREEZE_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), ".breeze");
}

/**
 * Parse the `breeze_status` counts from an inbox.json payload WITHOUT
 * running a full JSON.parse on the whole file. We still use JSON.parse,
 * but only on the fast path; a real notification list is small enough
 * (<1000 entries) that this is well under the 30ms budget.
 */
interface Counts {
  last_poll: string;
  new: number;
  human: number;
  // For the "X PRs · Y issues" summary.
  new_by_type: Map<string, number>;
}

function readCounts(inboxPath: string): Counts | null {
  let raw: string;
  try {
    raw = readFileSync(inboxPath, "utf-8");
  } catch {
    return null;
  }
  if (raw.length === 0) return null;
  let parsed: {
    last_poll?: string;
    notifications?: Array<{ breeze_status?: string; type?: string }>;
  };
  try {
    parsed = JSON.parse(raw) as {
      last_poll?: string;
      notifications?: Array<{ breeze_status?: string; type?: string }>;
    };
  } catch {
    return null;
  }
  const notifications = Array.isArray(parsed.notifications)
    ? parsed.notifications
    : [];
  const counts: Counts = {
    last_poll: typeof parsed.last_poll === "string" ? parsed.last_poll : "",
    new: 0,
    human: 0,
    new_by_type: new Map(),
  };
  for (const n of notifications) {
    const st = n?.breeze_status;
    if (st === "new") {
      counts.new += 1;
      const t = typeof n.type === "string" ? n.type : "";
      counts.new_by_type.set(t, (counts.new_by_type.get(t) ?? 0) + 1);
    } else if (st === "human") {
      counts.human += 1;
    }
  }
  return counts;
}

function formatNewSummary(byType: Map<string, number>): string {
  if (byType.size === 0) return "";
  const entries = [...byType.entries()].sort((a, b) => b[1] - a[1]);
  const parts = entries.map(([type, count]) => {
    switch (type) {
      case "PullRequest":
        return `${count} PRs`;
      case "Issue":
        return `${count} issues`;
      case "Discussion":
        return `${count} discussions`;
      case "Release":
        return `${count} releases`;
      case "SecurityAlert":
        return `${count} security`;
      default:
        return `${count} ${type}`;
    }
  });
  return parts.join(" · ");
}

/**
 * Read/write the `.bell_state` file. The file is a single line with the
 * format `<last_poll> <new_count> <human_count>` — same as the bash
 * script's writer.
 */
interface BellState {
  prevPoll: string;
  prevNew: number;
  prevHuman: number;
}

function readBellState(path: string): BellState | null {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    const parts = raw.split(/\s+/u);
    const prevPoll = parts[0] ?? "";
    const prevNew = Number.parseInt(parts[1] ?? "0", 10) || 0;
    const prevHuman = Number.parseInt(parts[2] ?? "0", 10) || 0;
    return { prevPoll, prevNew, prevHuman };
  } catch {
    return null;
  }
}

function writeBellState(path: string, counts: Counts): void {
  try {
    writeFileSync(
      path,
      `${counts.last_poll} ${counts.new} ${counts.human}\n`,
      "utf-8",
    );
  } catch {
    // ignore — statusline is best-effort
  }
}

/**
 * Drain stdin silently. Claude Code pipes a small JSON payload; we don't
 * need it, but we must consume it so the pipe doesn't stay open.
 *
 * This implementation is non-blocking: we read whatever is queued on the
 * non-blocking descriptor, but do NOT wait. Cold start stays tight.
 */
function drainStdin(): void {
  try {
    // `readFileSync(0)` blocks until EOF, which is what shell `cat` does.
    // For statusline use this is fine because Claude Code closes stdin
    // right after writing its JSON payload.
    readFileSync(0);
  } catch {
    // No stdin or read failed — fine.
  }
}

/**
 * Render the statusline. Pure function — takes counts + prior bell state
 * and returns the single-line string to print (or `null` to print
 * nothing). Exposed so tests can exercise the formatter without touching
 * the filesystem.
 */
export function renderStatusline(
  counts: Counts,
  prior: BellState | null,
): { line: string | null; ring: boolean } {
  const humanPart = counts.human > 0 ? `⚠ ${counts.human} need you · ` : "";
  const newSummary = formatNewSummary(counts.new_by_type);
  const hasContent = humanPart.length > 0 || newSummary.length > 0;
  if (!hasContent) return { line: null, ring: false };

  let suffix = "";
  let ring = false;
  if (prior && prior.prevPoll !== counts.last_poll) {
    if (counts.human > prior.prevHuman) {
      const diff = counts.human - prior.prevHuman;
      suffix = ` (+${diff} needs you)`;
      ring = true;
    } else if (counts.new > prior.prevNew) {
      const diff = counts.new - prior.prevNew;
      suffix = ` (+${diff} new)`;
      ring = true;
    }
  }

  return { line: `/breeze: ${humanPart}${newSummary}${suffix}`, ring };
}

export function main(
  nowSecs: number = Math.floor(Date.now() / 1000),
): number {
  // Per spec, always drain stdin first.
  drainStdin();

  const breezeDir = resolveBreezeDir();
  const inboxPath = join(breezeDir, "inbox.json");
  const bellStatePath = join(breezeDir, ".bell_state");

  if (!existsSync(inboxPath)) return 0;

  // Staleness check — >10 min since last mtime means the poller is dead.
  try {
    const mtimeSecs = Math.floor(statSync(inboxPath).mtimeMs / 1000);
    if (nowSecs - mtimeSecs > STALE_THRESHOLD_SECS) {
      process.stdout.write("/breeze: stale (poller not running?)\n");
      return 0;
    }
  } catch {
    // Inbox exists check said yes but stat failed; treat as missing.
    return 0;
  }

  const counts = readCounts(inboxPath);
  if (!counts) return 0;

  const prior = readBellState(bellStatePath);
  const { line, ring } = renderStatusline(counts, prior);
  writeBellState(bellStatePath, counts);

  if (ring) process.stdout.write("\u0007");
  if (line) process.stdout.write(`${line}\n`);
  return 0;
}

// Run only when this file is executed directly (i.e. `node dist/breeze-statusline.js`),
// not when imported.
const isDirectRun =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /breeze-statusline(\.[cm]?js)?$/u.test(process.argv[1]);
if (isDirectRun) {
  process.exit(main());
}
