/**
 * TypeScript port of the Rust auto daemon's notification poller
 * (`fetcher.rs`, ~981 lines).
 *
 * SINGLE-WRITER RULE (spec doc 2 §1.3, matches core/store.ts):
 * -------------------------------------------------------------
 * This module — specifically `pollOnce` — is the ONLY writer of
 * `~/.first-tree/auto/inbox.json` under the TS daemon backend. Broker, HTTP, and
 * bus (Phase 3b/3c) are read-only with respect to the inbox.
 *
 * The on-disk format is bit-compatible with the Rust fetcher:
 * `runtime/store.ts` emits the same key order as `entry_to_json`, uses JSON
 * `null` for nullable fields, and writes via atomic tmp+rename.
 *
 * Throttling (ported 1:1 from `gh_executor.rs`):
 * ---------------------------------------------
 * The Rust fetcher rate-limits `gh` calls across three buckets (core,
 * search, write). The daemon poller only uses `core` (notifications +
 * GraphQL are both read-only core-bucket calls), so we keep a single
 * scalar `nextAllowedEpochMs` plus a `rateLimitStreak` counter that
 * escalates backoff exponentially from 60s up to 60*16=960s (16min) on
 * consecutive 429/abuse responses. See `registerRateLimit`.
 *
 * Spec refs:
 *   - the inbox/activity-log schema (historical migration doc, now removed; see git history) (inbox shape)
 *   - the broker/agent lifecycle spec (historical migration doc, now removed; see git history) §1 (poll cadence)
 *   - Rust parity: `fetcher.rs::Fetcher::poll_once` and
 *     `gh_executor.rs::{GhExecutor,is_rate_limited,command_is_mutating}`
 *
 * Thin relationship to `commands/poll.ts`:
 *   - `poll.ts` is the one-shot CLI (`first-tree breeze poll`) that
 *     executes exactly one fetch + write + exit. It is tested standalone.
 *   - This daemon poller wraps the same core functions (`parseNotifications`,
 *     `sortEntries`, `enrichWithLabels`, `classifyEntries`, `diffEvents`)
 *     in a long-running loop with rate-limit backoff and AbortController
 *     cancellation.
 */

import { existsSync, mkdirSync } from "node:fs";

import { appendActivityEvent } from "../runtime/activity-log.js";
import { GhClient, GhExecError } from "../runtime/gh.js";
import type { AutoPaths } from "../runtime/paths.js";
import { updateInbox } from "../runtime/store.js";
import {
  classifyEntries,
  diffEvents,
  enrichWithLabels,
  parseNotifications,
  sortEntries,
  splitConcatenatedJsonArrays,
} from "../commands/poll.js";
import type { Inbox } from "../runtime/types.js";

export interface PollerLogger {
  info: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

const DEFAULT_LOGGER: PollerLogger = {
  info: (line) => process.stdout.write(`${line}\n`),
  warn: (line) => process.stderr.write(`WARN: ${line}\n`),
  error: (line) => process.stderr.write(`ERROR: ${line}\n`),
};

export interface PollerOptions {
  /** Cadence between polls, in seconds. */
  pollIntervalSec: number;
  /** GitHub host (usually `github.com`). */
  host: string;
  /** Injected `gh` wrapper. Tests supply a stub. */
  gh?: GhClient;
  /** Filesystem layout. Production code passes `resolveAutoPaths()`. */
  paths: AutoPaths;
  /** Abort signal for cooperative shutdown (wired from SIGTERM handler). */
  signal?: AbortSignal;
  /** `Date.now`-style clock override for tests. */
  now?: () => number;
  /** Logger sink. Defaults to stdout/stderr. */
  logger?: PollerLogger;
  /**
   * Injected sleep used between polls and while backing off on rate
   * limits. Tests can replace this with an instant resolver.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface PollOutcome {
  /** Total entries in the inbox this cycle. */
  total: number;
  /** Number classified as `new`. */
  newCount: number;
  /** One-line warnings (degraded fetch, enrichment partial, etc). */
  warnings: string[];
  /** True if GitHub returned a rate-limit signature. */
  rateLimited: boolean;
}

interface PollOnceDeps {
  gh: GhClient;
  paths: AutoPaths;
  host: string;
  now: () => number;
}

/** Seconds-precision ISO-8601 UTC, matching `date -u +%Y-%m-%dT%H:%M:%SZ`. */
function formatUtcIso(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
}

/**
 * Best-effort `gh`-output classifier. Copy of `is_rate_limited` in
 * `gh_executor.rs:247-254` — kept in sync with the Rust heuristic.
 */
export function isRateLimited(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return (
    combined.includes("secondary rate limit") ||
    combined.includes("rate limit exceeded") ||
    combined.includes("api rate limit") ||
    combined.includes("abuse detection") ||
    combined.includes("retry after")
  );
}

/**
 * Exponential backoff schedule. Mirrors `register_rate_limit`
 * (`gh_executor.rs:154-167`): base 60s, doubled per consecutive
 * 429/abuse response, capped at `60s * 2^4 = 960s` (16min).
 */
export function rateLimitBackoffMs(streak: number): number {
  const exponent = Math.min(Math.max(streak, 1), 4);
  return 60_000 * Math.pow(2, exponent);
}

async function defaultSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) return;
  return new Promise<void>((resolve) => {
    const handle = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(handle);
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run a single poll cycle: fetch notifications, enrich labels, classify,
 * write inbox.json, append activity events. Returns a structured
 * outcome; never throws on GitHub-side failure (warnings only), to
 * mirror the Rust fetcher's degraded behaviour (fetcher.rs:89-99).
 */
export async function pollOnce(deps: PollOnceDeps): Promise<PollOutcome> {
  const { gh, paths, host, now } = deps;
  if (!existsSync(paths.root)) mkdirSync(paths.root, { recursive: true });

  const warnings: string[] = [];

  // Fetch notifications. `--paginate` concatenates pages; we split.
  let rawPages: string[];
  try {
    const stdout = gh.runChecked("fetch notifications", [
      "api",
      // `participating=true` restricts to direct-participation notifications
      // and respects GitHub's server-side spam filter. `parseNotifications`
      // further narrows those results to explicit mentions and review
      // requests so breeze does not act on generic author/assignee/comment
      // traffic. `?all=true` was previously used here but bypassed the
      // filter, causing breeze to act on mention-then-delete spam surfaced
      // to no one in the UI (#251).
      "/notifications?participating=true",
      "--paginate",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
    ]);
    rawPages = splitConcatenatedJsonArrays(stdout);
  } catch (err) {
    if (err instanceof GhExecError) {
      const rateLimited = isRateLimited(err.stdout, err.stderr);
      warnings.push(
        `GitHub notifications fetch failed: ${err.message.split("\n")[0]}`,
      );
      return {
        total: 0,
        newCount: 0,
        warnings,
        rateLimited,
      };
    }
    throw err;
  }

  const entries = parseNotifications(rawPages, host);
  sortEntries(entries);

  const enrichmentWarning = enrichWithLabels(entries, gh, host);
  if (enrichmentWarning) {
    warnings.push(`label enrichment degraded: ${enrichmentWarning}`);
  }
  classifyEntries(entries);

  const pollTs = formatUtcIso(now());
  const nextInbox: Inbox = { last_poll: pollTs, notifications: entries };

  let diff: ReturnType<typeof diffEvents> = [];
  await updateInbox(
    (current) => {
      diff = diffEvents(current, entries);
      return nextInbox;
    },
    { inboxPath: paths.inbox },
  );

  for (const ev of diff) {
    if (ev.kind === "new") {
      appendActivityEvent(paths.activityLog, {
        ts: pollTs,
        event: "new",
        id: ev.entry.id,
        type: ev.entry.type,
        repo: ev.entry.repo,
        title: ev.entry.title,
        url: ev.entry.html_url,
      });
    } else if (ev.kind === "transition" && ev.from && ev.to) {
      appendActivityEvent(paths.activityLog, {
        ts: pollTs,
        event: "transition",
        id: ev.entry.id,
        type: ev.entry.type,
        repo: ev.entry.repo,
        title: ev.entry.title,
        url: ev.entry.html_url,
        from: ev.from,
        to: ev.to,
      });
    }
  }

  const total = entries.length;
  const newCount = entries.filter((e) => e.breeze_status === "new").length;
  return { total, newCount, warnings, rateLimited: false };
}

/**
 * The long-running poll loop. Resolves when `signal` aborts. Callers
 * fire-and-await this inside `runner-skeleton.ts`.
 *
 * Behaviour:
 *   - Runs `pollOnce` immediately on start.
 *   - Sleeps `pollIntervalSec` between successful cycles.
 *   - On rate-limit detection, escalates the sleep per
 *     `rateLimitBackoffMs(streak)` until a clean cycle resets the streak.
 *   - `signal.aborted` triggers a clean return; in-flight `pollOnce` is
 *     not force-cancelled (the advisory lock on inbox.json must drain).
 */
export async function runPoller(options: PollerOptions): Promise<void> {
  const gh = options.gh ?? new GhClient();
  const logger = options.logger ?? DEFAULT_LOGGER;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;

  let rateLimitStreak = 0;

  while (!signal?.aborted) {
    let outcome: PollOutcome;
    try {
      outcome = await pollOnce({
        gh,
        paths: options.paths,
        host: options.host,
        now,
      });
    } catch (err) {
      // Local/setup error (not a gh-side failure). Log and retry after
      // a regular interval — the operator needs to fix the environment.
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`poll cycle crashed: ${message}`);
      await sleep(options.pollIntervalSec * 1000, signal);
      continue;
    }

    for (const warning of outcome.warnings) logger.warn(warning);

    if (outcome.rateLimited) {
      rateLimitStreak += 1;
      const backoff = rateLimitBackoffMs(rateLimitStreak);
      logger.warn(
        `rate-limited by GitHub; sleeping ${Math.round(backoff / 1000)}s (streak=${rateLimitStreak})`,
      );
      await sleep(backoff, signal);
      continue;
    }

    rateLimitStreak = 0;
    logger.info(
      `auto: polled ${outcome.total} notifications (${outcome.newCount} new)`,
    );
    await sleep(options.pollIntervalSec * 1000, signal);
  }
}
