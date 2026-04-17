/**
 * Phase 5: the per-thread state machine that sits between the candidate
 * loop and the dispatcher. Mirrors the logic in
 * `service.rs`:
 *   - `should_schedule`        — gate on ThreadRecord retry/backoff
 *   - `handle_completion`      — persist ThreadRecord + task.env updates
 *   - `record_setup_failure`   — workspace failures bump the retry counter
 *   - `enqueue_recoverable_tasks` — recover orphaned `running` tasks at boot
 *   - `retry_delay(n)` = 60·2^min(n,6) seconds
 *   - `operator_repo_for` / `should_route_to_operator_repo`
 *
 * The dispatcher itself stays minimal — it just runs agents. Scheduler
 * decisions ride on top via:
 *   - `shouldSchedule(candidate)` before `Dispatcher.submit`
 *   - `handleCompletion(record)` in the dispatcher's `onCompletion` hook
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CompletionRecord } from "./dispatcher.js";
import type { GhClient } from "./gh-client.js";
import type { ThreadStore } from "./thread-store.js";
import { encodeMultiline } from "../runtime/task-util.js";
import { shouldIgnoreLatestSelfActivity } from "./gh-client.js";
import {
  candidateFromTaskMetadata,
  effectiveWorkspaceRepo,
  toDispatcherCandidate,
  type TaskCandidate,
} from "../runtime/task.js";
import type { TaskCandidate as DispatchCandidate } from "./dispatcher.js";
import type { AgentIdentity } from "./runner.js";

/**
 * `60 · 2^min(failureCount, 6)` seconds. Matches Rust `retry_delay`.
 * With the 6-shift cap, backoff saturates at 64 minutes.
 */
export function retryDelaySec(failureCount: number): number {
  const shift = Math.max(0, Math.min(failureCount, 6));
  return 60 * (1 << shift);
}

/** Poll-interval-bounded variant used in the actual retry write. */
export function failureRetryDelaySec(
  failureCount: number,
  pollIntervalSec: number,
): number {
  return Math.min(retryDelaySec(failureCount), pollIntervalSec);
}

export interface SchedulerOptions {
  store: ThreadStore;
  ghClient?: GhClient;
  identity: AgentIdentity;
  /** Cap used by `failureRetryDelaySec`. Daemon passes `config.pollIntervalSec`. */
  pollIntervalSec: number;
  nowSec?: () => number;
  logger?: {
    warn: (line: string) => void;
  };
}

export class Scheduler {
  private readonly store: ThreadStore;
  private readonly ghClient?: GhClient;
  private readonly identity: AgentIdentity;
  private readonly pollIntervalSec: number;
  private readonly nowSec: () => number;
  private readonly logger: { warn: (line: string) => void };

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.ghClient = options.ghClient;
    this.identity = options.identity;
    this.pollIntervalSec = options.pollIntervalSec;
    this.nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1_000));
    this.logger = options.logger ?? { warn: () => undefined };
  }

  /**
   * Port of `Service::should_schedule`. Always touches the ThreadRecord
   * so `last_seen_updated_at` reflects the most recent poll. Returns
   * `false` when the thread is within its backoff window, already
   * handled at this `updated_at`, or dominated by a current self/bot
   * activity.
   */
  async shouldSchedule(candidate: TaskCandidate): Promise<boolean> {
    const now = this.nowSec();
    const record = this.store.loadThreadRecord(candidate.threadKey);
    record.threadKey = candidate.threadKey;
    record.repo = candidate.repo;
    record.lastSeenUpdatedAt = candidate.updatedAt;
    this.store.saveThreadRecord(record);

    if (record.nextRetryEpoch > now) return false;
    if (
      record.lastHandledUpdatedAt.length > 0 &&
      candidate.updatedAt <= record.lastHandledUpdatedAt
    ) {
      return false;
    }

    if (this.ghClient) {
      let activity = null;
      try {
        activity = await this.ghClient.latestVisibleActivity(candidate);
      } catch (err) {
        this.logger.warn(
          `scheduler: latestVisibleActivity failed for ${candidate.threadKey}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (
        shouldIgnoreLatestSelfActivity(
          this.identity.login,
          activity,
          candidate.updatedAt,
        )
      ) {
        record.lastHandledUpdatedAt = candidate.updatedAt;
        record.lastResult = "skipped";
        record.nextRetryEpoch = 0;
        this.store.saveThreadRecord(record);
        return false;
      }
    }

    return true;
  }

  /**
   * Port of `Service::handle_completion`. Called from the dispatcher's
   * `onCompletion` hook. Persists the task.env update and mutates the
   * ThreadRecord backoff fields.
   */
  handleCompletion(record: CompletionRecord): void {
    const now = this.nowSec();
    const meta = this.store.readTaskMetadata(record.taskId);
    meta.set("finished_at", String(now));

    let threadRecord = this.store.loadThreadRecord(record.threadKey);
    threadRecord.threadKey = record.threadKey;
    threadRecord.repo = record.candidate.repo;
    threadRecord.lastSeenUpdatedAt = record.candidate.updatedAt;
    threadRecord.lastTaskId = record.taskId;

    if (record.phase === "completed") {
      const status = record.status ?? "handled";
      meta.set("status", status);
      if (record.summary) meta.set("summary", encodeMultiline(record.summary));
      if (record.runnerOutputPath)
        meta.set("runner_output_path", record.runnerOutputPath);
      if (record.runnerName) meta.set("runner", record.runnerName);

      if (status === "handled" || status === "skipped") {
        threadRecord.lastHandledUpdatedAt = record.candidate.updatedAt;
        threadRecord.failureCount = 0;
        threadRecord.nextRetryEpoch = 0;
      } else if (status === "failed") {
        threadRecord.failureCount = safeAdd(threadRecord.failureCount, 1);
        threadRecord.nextRetryEpoch =
          now +
          failureRetryDelaySec(threadRecord.failureCount, this.pollIntervalSec);
      }
      threadRecord.lastResult = status;
    } else if (record.phase === "skipped-claim") {
      // Claim held elsewhere — don't bump anything.
      return;
    } else {
      // failed | timed_out: bump retry counter.
      meta.set("status", record.phase === "timed_out" ? "timed_out" : "failed");
      if (record.error) meta.set("summary", encodeMultiline(record.error));
      threadRecord.failureCount = safeAdd(threadRecord.failureCount, 1);
      threadRecord.nextRetryEpoch =
        now +
        failureRetryDelaySec(threadRecord.failureCount, this.pollIntervalSec);
      threadRecord.lastResult = meta.get("status") ?? "failed";
    }

    this.store.writeTaskMetadata(record.taskId, mapToRecord(meta));
    this.store.saveThreadRecord(threadRecord);
  }

  /**
   * Port of `Service::record_setup_failure`. Invoked when workspace prep
   * or snapshotting fails before the agent runs.
   */
  recordSetupFailure(args: {
    taskId: string;
    candidate: TaskCandidate;
    error: string;
  }): void {
    const now = this.nowSec();
    this.store.writeTaskMetadata(args.taskId, {
      task_id: args.taskId,
      status: "failed",
      repo: args.candidate.repo,
      workspace_repo: effectiveWorkspaceRepo(args.candidate),
      thread_key: args.candidate.threadKey,
      title: encodeMultiline(args.candidate.title),
      kind: args.candidate.kind,
      reason: args.candidate.reason,
      started_at: String(now),
      finished_at: String(now),
      updated_at: args.candidate.updatedAt,
      source: args.candidate.source,
      summary: encodeMultiline(args.error),
      runner_output_path: join(
        this.store.taskDir(args.taskId),
        "runner-output.txt",
      ),
    });

    const record = this.store.loadThreadRecord(args.candidate.threadKey);
    record.threadKey = args.candidate.threadKey;
    record.repo = args.candidate.repo;
    record.lastSeenUpdatedAt = args.candidate.updatedAt;
    record.failureCount = safeAdd(record.failureCount, 1);
    record.nextRetryEpoch =
      now + failureRetryDelaySec(record.failureCount, this.pollIntervalSec);
    record.lastResult = "failed";
    record.lastTaskId = args.taskId;
    this.store.saveThreadRecord(record);
  }

  /**
   * Port of `Service::enqueue_recoverable_tasks`. Reads the on-disk
   * task metadata and returns any candidate whose `status=running` and
   * `finished_at` is unset — these are orphans from a crashed daemon.
   * Marks them `orphaned` on disk before returning.
   */
  enqueueRecoverableTasks(host: string): TaskCandidate[] {
    const now = this.nowSec();
    const recovered: TaskCandidate[] = [];
    for (const [taskId, metadata] of this.store.listTaskMetadata()) {
      const status = metadata.get("status") ?? "";
      if (status !== "running") continue;
      const finished = metadata.get("finished_at") ?? "";
      if (finished.trim().length > 0) continue;
      const candidate = candidateFromTaskMetadata(metadata, host);
      if (!candidate) continue;

      metadata.set("status", "orphaned");
      metadata.set("finished_at", String(now));
      metadata.set(
        "summary",
        encodeMultiline(
          "breeze-runner recovered this unfinished running task and re-queued it",
        ),
      );
      this.store.writeTaskMetadata(taskId, mapToRecord(metadata));
      recovered.push(candidate);
    }
    recovered.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.threadKey.localeCompare(b.threadKey);
    });
    return recovered;
  }

  /**
   * Snapshot an in-progress task on launch. Mirrors the `write_task_metadata`
   * call inside `dispatch_pending`. Called by the scheduling glue just
   * before `Dispatcher.submit()` returns.
   */
  writeRunningMetadata(args: {
    taskId: string;
    candidate: TaskCandidate;
    runner: string;
    workspacePath?: string;
    mirrorDir?: string;
    repoUrl?: string;
    snapshotDir?: string;
    ghShimDir?: string;
  }): void {
    const now = this.nowSec();
    this.store.writeTaskMetadata(args.taskId, {
      task_id: args.taskId,
      status: "running",
      repo: args.candidate.repo,
      workspace_repo: effectiveWorkspaceRepo(args.candidate),
      thread_key: args.candidate.threadKey,
      title: encodeMultiline(args.candidate.title),
      kind: args.candidate.kind,
      reason: args.candidate.reason,
      started_at: String(now),
      updated_at: args.candidate.updatedAt,
      source: args.candidate.source,
      runner: args.runner,
      ...(args.workspacePath ? { workspace_path: args.workspacePath } : {}),
      ...(args.mirrorDir ? { mirror_dir: args.mirrorDir } : {}),
      ...(args.repoUrl ? { repo_url: args.repoUrl } : {}),
      ...(args.snapshotDir ? { snapshot_dir: args.snapshotDir } : {}),
      ...(args.ghShimDir ? { gh_shim_dir: args.ghShimDir } : {}),
    });
  }

  /** Convenience: convert to dispatcher shape. */
  asDispatcherCandidate(candidate: TaskCandidate): DispatchCandidate {
    return toDispatcherCandidate(candidate);
  }
}

/* --------------------- operator-repo routing ------------------------- */

/** `login/login` — the operator's home repo. */
export function operatorRepoFor(login: string): string {
  return `${login}/${login}`;
}

/**
 * Read the raw text of any relevant snapshot files, lowercase, for
 * substring matching. Used by `shouldRouteToOperatorRepo`.
 */
export function readRoutingSnapshotText(snapshotDir: string): string {
  const files = [
    "issue-view.json",
    "pr-view.json",
    "subject.json",
    "latest-comment.json",
    "issue-comments.json",
    "pr-reviews.json",
  ];
  let combined = "";
  for (const name of files) {
    const path = join(snapshotDir, name);
    if (!existsSync(path)) continue;
    combined += readFileSync(path, "utf8");
    combined += "\n";
  }
  return combined.toLowerCase();
}

/**
 * Port of `should_route_to_operator_repo` — heuristic for spotting
 * requests to reconfigure the breeze-runner itself.
 */
export function shouldRouteToOperatorRepo(
  contents: string,
  login: string,
): boolean {
  const lowerLogin = login.toLowerCase();
  const asksForChange = [
    "configure",
    "update",
    "change",
    "fix",
    "modify",
    "adjust",
    "tune",
    "restart",
  ].some((word) => contents.includes(word));
  const mentionsBreezeRunner = contents.includes("breeze-runner");
  const directsToOperator = [
    `@${lowerLogin}`,
    `${lowerLogin}'s agent`,
    `${lowerLogin}/${lowerLogin}`,
    "your agent",
    "agent-team-foundation/breeze",
    "breeze-runner service",
  ].some((pattern) => contents.includes(pattern));
  return mentionsBreezeRunner && asksForChange && directsToOperator;
}

/**
 * Decide whether this candidate's workspace should redirect to the
 * operator's home repo. Pure decision — call sites do the write.
 */
export function routeWorkspaceCandidate(args: {
  candidate: TaskCandidate;
  identityLogin: string;
  snapshotDir?: string;
}): TaskCandidate {
  const operatorRepo = operatorRepoFor(args.identityLogin);
  if (effectiveWorkspaceRepo(args.candidate) === operatorRepo) {
    return { ...args.candidate, workspaceRepo: operatorRepo };
  }
  if (!args.snapshotDir) return args.candidate;
  const routingText = readRoutingSnapshotText(args.snapshotDir);
  if (shouldRouteToOperatorRepo(routingText, args.identityLogin)) {
    return { ...args.candidate, workspaceRepo: operatorRepo };
  }
  return args.candidate;
}

/* ---------------------- local helpers -------------------------------- */

function mapToRecord(map: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of map) out[k] = v;
  return out;
}

function safeAdd(a: number, b: number): number {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  return a + b;
}
