/**
 * TS port of `first-tree-breeze/breeze-runner/src/task.rs`.
 *
 * `TaskCandidate` is the canonical shape produced by the notification
 * poll / search path and consumed by the dispatcher. `ThreadRecord`
 * is the per-thread retry/state record persisted under
 * `<runnerHome>/threads/<id>.env`.
 *
 * This is a richer candidate than the dispatcher's minimal interface
 * (`daemon/dispatcher.ts::TaskCandidate`) — it keeps the full API/web
 * URL pair, reason, source, and lets callers derive stable IDs or
 * comment-anchored task URLs. Use `toDispatcherCandidate()` to hand
 * one to the dispatcher.
 */

import type { TaskCandidate as DispatchCandidate } from "../daemon/dispatcher.js";
import {
  classifyNotification,
  priorityFor,
  shouldProcessReason,
  taskKindFromString,
  type TaskKind,
} from "./task-kind.js";
import {
  canonicalApiPath,
  decodeMultiline,
  encodeMultiline,
  stableFileId,
} from "./task-util.js";

export interface TaskCandidate {
  /** Origin: `notifications` | `review-search` | `assigned-search` | `recovered-running`. */
  source: string;
  /** Source repo (`owner/repo`). */
  repo: string;
  /** Operator-routing override (empty string = same as `repo`). */
  workspaceRepo: string;
  /** Canonical thread key — stable across hosts. */
  threadKey: string;
  kind: TaskKind;
  /** GitHub notification `reason`; empty for search-derived tasks. */
  reason: string;
  title: string;
  /** Browser-friendly URL (may be empty). */
  webUrl: string;
  /** `api.github.com` URL (may be empty for notifications w/o api_url). */
  apiUrl: string;
  /** API URL for the latest comment on this thread (may be empty). */
  latestCommentApiUrl: string;
  /** GitHub-supplied `updated_at` (ISO-8601). */
  updatedAt: string;
  priority: number;
}

/** Resolve effective workspace repo (falls back to `repo`). */
export function effectiveWorkspaceRepo(task: TaskCandidate): string {
  return task.workspaceRepo.trim().length > 0 ? task.workspaceRepo : task.repo;
}

/**
 * Stable file-id per candidate. Uses fnv1a64 over (thread_key, updated_at,
 * repo, kind, source) so two candidates with identical content share ids.
 */
export function stableIdFor(task: TaskCandidate): string {
  return stableFileId(
    `${task.threadKey}|${task.updatedAt}|${task.repo}|${task.kind}|${task.source}`,
  );
}

/** Browser URL preferring `webUrl` then `apiUrl`. */
export function displayUrl(task: TaskCandidate): string {
  if (task.webUrl.length > 0) return task.webUrl;
  if (task.apiUrl.length > 0) return task.apiUrl;
  return "";
}

/**
 * The URL the agent should actually open. Prefers an anchored link to
 * the latest comment when the API url exposes the comment id.
 */
export function taskUrl(task: TaskCandidate): string {
  const anchored = latestCommentWebUrl(task);
  if (anchored !== undefined) return anchored;
  return displayUrl(task);
}

/** Extract PR number from the task's URLs or thread key. */
export function taskPrNumber(task: TaskCandidate): number | undefined {
  for (const candidate of [task.webUrl, task.apiUrl, task.threadKey]) {
    const n = extractPrNumber(candidate);
    if (n !== undefined) return n;
  }
  return undefined;
}

/** Extract issue number similarly. */
export function taskIssueNumber(task: TaskCandidate): number | undefined {
  for (const candidate of [task.webUrl, task.apiUrl, task.threadKey]) {
    const n = extractIssueNumber(candidate);
    if (n !== undefined) return n;
  }
  return undefined;
}

function latestCommentWebUrl(task: TaskCandidate): string | undefined {
  if (task.latestCommentApiUrl.length === 0) return undefined;
  const commentId = extractIssueCommentId(task.latestCommentApiUrl);
  if (commentId === undefined) return undefined;
  const base =
    task.webUrl.length > 0
      ? task.webUrl
      : deriveWebUrl("github.com", task.repo, task.threadKey);
  if (base === undefined) return undefined;
  return `${base}#issuecomment-${commentId}`;
}

/** Build a notifications-sourced candidate. Returns undefined when it should be dropped. */
export function buildNotificationCandidate(args: {
  host: string;
  repo: string;
  subjectType: string;
  reason: string;
  title: string;
  apiUrl: string;
  latestCommentApiUrl: string;
  updatedAt: string;
}): TaskCandidate | undefined {
  const {
    host,
    repo,
    subjectType,
    reason,
    title,
    apiUrl,
    latestCommentApiUrl,
    updatedAt,
  } = args;
  if (repo.length === 0) return undefined;
  const kind = classifyNotification(subjectType, reason);
  if (kind === "other" || !shouldProcessReason(reason)) return undefined;

  const threadKey =
    apiUrl.length > 0
      ? canonicalApiPath(apiUrl)
      : latestCommentApiUrl.length > 0
        ? canonicalApiPath(latestCommentApiUrl)
        : `notification::${repo}::${subjectType}::${title}`;

  const webUrl = deriveWebUrl(host, repo, threadKey) ?? "";

  return {
    source: "notifications",
    repo,
    workspaceRepo: repo,
    threadKey,
    kind,
    reason,
    title,
    webUrl,
    apiUrl,
    latestCommentApiUrl,
    updatedAt,
    priority: priorityFor(kind, reason),
  };
}

export function buildReviewRequestCandidate(args: {
  repo: string;
  number: number;
  title: string;
  webUrl: string;
  updatedAt: string;
}): TaskCandidate {
  return {
    source: "review-search",
    repo: args.repo,
    workspaceRepo: args.repo,
    threadKey: `/repos/${args.repo}/pulls/${args.number}`,
    kind: "review_request",
    reason: "review_requested",
    title: args.title,
    webUrl: args.webUrl,
    apiUrl: `https://api.github.com/repos/${args.repo}/pulls/${args.number}`,
    latestCommentApiUrl: "",
    updatedAt: args.updatedAt,
    priority: priorityFor("review_request", "review_requested"),
  };
}

export function buildAssignedCandidate(args: {
  repo: string;
  number: number;
  title: string;
  webUrl: string;
  updatedAt: string;
  isPullRequest: boolean;
}): TaskCandidate {
  const kind: TaskKind = args.isPullRequest
    ? "assigned_pull_request"
    : "assigned_issue";
  const suffix = args.isPullRequest ? "pulls" : "issues";
  return {
    source: "assigned-search",
    repo: args.repo,
    workspaceRepo: args.repo,
    threadKey: `/repos/${args.repo}/${suffix}/${args.number}`,
    kind,
    reason: "assigned",
    title: args.title,
    webUrl: args.webUrl,
    apiUrl: `https://api.github.com/repos/${args.repo}/${suffix}/${args.number}`,
    latestCommentApiUrl: "",
    updatedAt: args.updatedAt,
    priority: priorityFor(kind, "assigned"),
  };
}

/** Convert a rich TaskCandidate into the dispatcher's minimal shape. */
export function toDispatcherCandidate(task: TaskCandidate): DispatchCandidate {
  const prNumber = taskPrNumber(task);
  const stableId = stableIdFor(task);
  return {
    threadKey: task.threadKey,
    notificationId: stableId,
    repo: task.repo,
    workspaceRepo: effectiveWorkspaceRepo(task),
    kind: task.kind,
    stableId,
    prNumber,
    title: task.title,
    taskUrl: taskUrl(task),
    priority: task.priority,
    updatedAt: task.updatedAt,
  };
}

/* -------------------------- ThreadRecord ----------------------------- */

export interface ThreadRecord {
  threadKey: string;
  repo: string;
  lastSeenUpdatedAt: string;
  lastHandledUpdatedAt: string;
  lastResult: string;
  failureCount: number;
  nextRetryEpoch: number;
  lastTaskId: string;
}

export function defaultThreadRecord(): ThreadRecord {
  return {
    threadKey: "",
    repo: "",
    lastSeenUpdatedAt: "",
    lastHandledUpdatedAt: "",
    lastResult: "",
    failureCount: 0,
    nextRetryEpoch: 0,
    lastTaskId: "",
  };
}

/** Serialize to a `key=value` block (values are newline-escaped). */
export function threadRecordToLines(record: ThreadRecord): string[] {
  return [
    `thread_key=${encodeMultiline(record.threadKey)}`,
    `repo=${encodeMultiline(record.repo)}`,
    `last_seen_updated_at=${encodeMultiline(record.lastSeenUpdatedAt)}`,
    `last_handled_updated_at=${encodeMultiline(record.lastHandledUpdatedAt)}`,
    `last_result=${encodeMultiline(record.lastResult)}`,
    `failure_count=${record.failureCount}`,
    `next_retry_epoch=${record.nextRetryEpoch}`,
    `last_task_id=${encodeMultiline(record.lastTaskId)}`,
  ];
}

export function threadRecordFromKv(
  entries: readonly (readonly [string, string])[],
): ThreadRecord {
  const record = defaultThreadRecord();
  for (const [key, value] of entries) {
    switch (key) {
      case "thread_key":
        record.threadKey = decodeMultiline(value);
        break;
      case "repo":
        record.repo = decodeMultiline(value);
        break;
      case "last_seen_updated_at":
        record.lastSeenUpdatedAt = decodeMultiline(value);
        break;
      case "last_handled_updated_at":
        record.lastHandledUpdatedAt = decodeMultiline(value);
        break;
      case "last_result":
        record.lastResult = decodeMultiline(value);
        break;
      case "failure_count":
        record.failureCount = toNonNegativeInt(value) ?? 0;
        break;
      case "next_retry_epoch":
        record.nextRetryEpoch = toNonNegativeInt(value) ?? 0;
        break;
      case "last_task_id":
        record.lastTaskId = decodeMultiline(value);
        break;
    }
  }
  return record;
}

/**
 * Reconstruct a candidate from the persisted `task_metadata.env`.
 * Mirrors `TaskCandidate::from_task_metadata` — used by service-start
 * recovery so a daemon restart can retry in-flight tasks.
 */
export function candidateFromTaskMetadata(
  metadata: ReadonlyMap<string, string>,
  host: string,
): TaskCandidate | undefined {
  const repo = metadata.get("repo")?.trim() ?? "";
  const threadKey = metadata.get("thread_key")?.trim() ?? "";
  const kindRaw = metadata.get("kind")?.trim();
  if (!repo || !threadKey || !kindRaw) return undefined;
  const kind = taskKindFromString(kindRaw);
  if (kind === undefined) return undefined;

  const reason = metadata.get("reason") ?? "";
  const title = decodeMultiline(metadata.get("title") ?? "");
  const updatedAt = metadata.get("updated_at") ?? "";
  const source = metadata.get("source") ?? "recovered-running";

  const apiUrl = threadKey.startsWith("/repos/")
    ? `https://api.github.com${threadKey}`
    : metadata.get("api_url") ?? "";
  const webUrlRaw = metadata.get("web_url") ?? "";
  const webUrl =
    webUrlRaw.trim().length > 0
      ? webUrlRaw
      : deriveWebUrl(host, repo, threadKey) ?? "";
  const latestCommentApiUrl = metadata.get("latest_comment_api_url") ?? "";

  const workspaceRepoRaw = metadata.get("workspace_repo") ?? "";
  const workspaceRepo =
    workspaceRepoRaw.trim().length > 0 ? workspaceRepoRaw : repo;

  return {
    source,
    repo,
    workspaceRepo,
    threadKey,
    kind,
    reason,
    title,
    webUrl,
    apiUrl,
    latestCommentApiUrl,
    updatedAt,
    priority: priorityFor(kind, reason),
  };
}

/* -------------------------- helpers ---------------------------------- */

function extractPrNumber(value: string): number | undefined {
  for (const marker of ["/pull/", "/pulls/"]) {
    const idx = value.indexOf(marker);
    if (idx === -1) continue;
    const n = readLeadingDigits(value.slice(idx + marker.length));
    if (n !== undefined) return n;
  }
  return undefined;
}

function extractIssueNumber(value: string): number | undefined {
  const idx = value.indexOf("/issues/");
  if (idx === -1) return undefined;
  return readLeadingDigits(value.slice(idx + "/issues/".length));
}

function extractIssueCommentId(value: string): number | undefined {
  const idx = value.indexOf("/issues/comments/");
  if (idx === -1) return undefined;
  return readLeadingDigits(value.slice(idx + "/issues/comments/".length));
}

function readLeadingDigits(value: string): number | undefined {
  let i = 0;
  while (i < value.length && value.charCodeAt(i) >= 48 && value.charCodeAt(i) <= 57) {
    i += 1;
  }
  if (i === 0) return undefined;
  const n = Number.parseInt(value.slice(0, i), 10);
  return Number.isFinite(n) ? n : undefined;
}

function deriveWebUrl(
  host: string,
  repo: string,
  threadKey: string,
): string | undefined {
  const pr = extractPrNumber(threadKey);
  if (pr !== undefined) return `https://${host}/${repo}/pull/${pr}`;
  const issue = extractIssueNumber(threadKey);
  if (issue !== undefined) return `https://${host}/${repo}/issues/${issue}`;
  return undefined;
}

function toNonNegativeInt(value: string): number | undefined {
  const n = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}
