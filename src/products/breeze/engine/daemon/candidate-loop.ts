/**
 * Phase 4: candidate-poll loop that feeds the dispatcher.
 *
 * Runs in parallel with the inbox poller (`daemon/poller.ts`). The
 * inbox poller writes `~/.breeze/inbox.json` for the dashboard; this
 * loop calls `GhClient.collectCandidates()` (broker-backed) and hands
 * each candidate to `Dispatcher.submit()`.
 *
 * Shape deliberately mirrors `poller.ts` so the two loops share idioms:
 *   - Single `run(options)` entry that returns when `signal` aborts.
 *   - Rate-limit backoff via `rateLimitBackoffMs` from the poller module.
 *   - Sleep is injectable for tests.
 */

import type { Bus } from "./bus.js";
import type { Dispatcher } from "./dispatcher.js";
import type { GhClient } from "./gh-client.js";
import { rateLimitBackoffMs } from "./poller.js";
import type { Scheduler } from "./scheduler.js";
import {
  toDispatcherCandidate,
  type TaskCandidate,
} from "../runtime/task.js";

export interface CandidateLoopLogger {
  info: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

const DEFAULT_LOGGER: CandidateLoopLogger = {
  info: (line) => process.stdout.write(`${line}\n`),
  warn: (line) => process.stderr.write(`WARN: ${line}\n`),
  error: (line) => process.stderr.write(`ERROR: ${line}\n`),
};

export interface CandidateLoopOptions {
  client: GhClient;
  dispatcher: Dispatcher;
  /** Shared bus — warnings are published as `activity` lines. */
  bus?: Bus;
  /** Seconds between candidate polls. Rust default: 60s. */
  pollIntervalSec: number;
  /** Max items per `gh search` call. Rust default: 10. */
  searchLimit: number;
  /** Include the search-bucket queries (review_requests / assigned). */
  includeSearch: boolean;
  /** Lookback window for notifications, seconds. Rust default: 24h. */
  lookbackSecs: number;
  /** Abort signal from the shared shutdown controller. */
  signal?: AbortSignal;
  /** Injected epoch-seconds clock. */
  nowSec?: () => number;
  logger?: CandidateLoopLogger;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Called after every cycle with the raw poll result so the caller
   * can persist ThreadRecord state (Phase 5). Defaults to no-op.
   */
  onCycle?: (outcome: CandidateCycleOutcome) => void;
  /**
   * Scheduler gate: dispatcher.submit is only called when
   * `scheduler.shouldSchedule(candidate)` returns true. When absent,
   * every candidate is submitted (back-compat with Phase 4).
   */
  scheduler?: Scheduler;
  /**
   * Recovery hook: called once before the first cycle to re-submit
   * orphaned `status=running` tasks. Scheduler constructs these.
   */
  recoverableCandidates?: () => TaskCandidate[];
}

export interface CandidateCycleOutcome {
  submitted: number;
  warnings: string[];
  rateLimited: boolean;
}

export async function runCandidateLoop(
  options: CandidateLoopOptions,
): Promise<void> {
  const logger = options.logger ?? DEFAULT_LOGGER;
  const nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1_000));
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal;

  // One-shot orphan recovery before the first cycle.
  if (options.recoverableCandidates) {
    for (const candidate of options.recoverableCandidates()) {
      if (
        options.scheduler &&
        !(await options.scheduler.shouldSchedule(candidate))
      ) {
        continue;
      }
      options.dispatcher.submit(toDispatcherCandidate(candidate));
    }
  }

  let rateLimitStreak = 0;

  while (!signal?.aborted) {
    let outcome: CandidateCycleOutcome;
    try {
      outcome = await runCandidateCycle(options, nowSec);
    } catch (err) {
      logger.error(
        `candidate cycle crashed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await sleep(options.pollIntervalSec * 1_000, signal);
      continue;
    }

    for (const warning of outcome.warnings) {
      logger.warn(`candidates: ${warning}`);
      options.bus?.publish({ kind: "activity", line: warning });
    }

    if (outcome.rateLimited) {
      rateLimitStreak += 1;
      const backoff = rateLimitBackoffMs(rateLimitStreak);
      logger.warn(
        `candidate search rate-limited; sleeping ${Math.round(backoff / 1000)}s (streak=${rateLimitStreak})`,
      );
      await sleep(backoff, signal);
      continue;
    }
    rateLimitStreak = 0;
    if (outcome.submitted > 0) {
      logger.info(`candidates: submitted ${outcome.submitted} task(s)`);
    }
    await sleep(options.pollIntervalSec * 1_000, signal);
  }
}

export async function runCandidateCycle(
  options: Pick<
    CandidateLoopOptions,
    | "client"
    | "dispatcher"
    | "searchLimit"
    | "includeSearch"
    | "lookbackSecs"
    | "onCycle"
    | "scheduler"
  >,
  nowSec: () => number,
): Promise<CandidateCycleOutcome> {
  const poll = await options.client.collectCandidates({
    limit: options.searchLimit,
    includeSearch: options.includeSearch,
    nowEpoch: nowSec(),
    lookbackSecs: options.lookbackSecs,
  });

  let submitted = 0;
  for (const candidate of poll.tasks) {
    if (options.scheduler) {
      const ok = await options.scheduler.shouldSchedule(candidate);
      if (!ok) continue;
    }
    options.dispatcher.submit(toDispatcherCandidate(candidate));
    submitted += 1;
  }
  const outcome: CandidateCycleOutcome = {
    submitted,
    warnings: poll.warnings,
    rateLimited: poll.searchRateLimited,
  };
  options.onCycle?.(outcome);
  return outcome;
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
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
