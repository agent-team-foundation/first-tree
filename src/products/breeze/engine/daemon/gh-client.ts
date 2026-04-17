/**
 * Phase 4: TS port of `gh.rs`.
 *
 * `GhClient` wraps a `GhExecutor` with the GitHub-specific query set
 * (notifications, review requests, assigned issues/PRs) and the
 * snapshot-hydration path (`writeTaskSnapshot`). Rate limiting +
 * write-cooldown are handled entirely by the executor; this module
 * only builds argv.
 *
 * Pure behaviour, except for the file writes in `writeTaskSnapshot`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  bucketForArgs,
  isRateLimited,
  type ExecOutput,
  type GhCommandSpec,
  type GhBucket,
  type GhExecutor,
} from "./gh-executor.js";
import {
  RepoFilter,
  searchScopesFor,
  type SearchScope,
} from "../runtime/repo-filter.js";
import {
  buildAssignedCandidate,
  buildNotificationCandidate,
  buildReviewRequestCandidate,
  taskIssueNumber,
  taskPrNumber,
  taskUrl,
  type TaskCandidate,
} from "../runtime/task.js";
import {
  canonicalApiPath,
  isRecentGithubTimestamp,
  parseTsvLine,
  shellQuote,
} from "../runtime/task-util.js";

export interface ThreadActivity {
  login: string;
  userType: string;
  updatedAt: string;
}

export interface CandidatePoll {
  tasks: TaskCandidate[];
  warnings: string[];
  searchAttempted: boolean;
  searchRateLimited: boolean;
}

export interface GhClientOptions {
  host: string;
  repoFilter: RepoFilter;
  executor: GhExecutor;
}

export class GhClient {
  private readonly host: string;
  private readonly repoFilter: RepoFilter;
  private readonly executor: GhExecutor;

  constructor(options: GhClientOptions) {
    this.host = options.host;
    this.repoFilter = options.repoFilter;
    this.executor = options.executor;
  }

  getExecutor(): GhExecutor {
    return this.executor;
  }

  /** `GET /notifications` with lookback + repo-filter enforcement. */
  async recentNotifications(
    nowEpoch: number,
    lookbackSecs: number,
  ): Promise<TaskCandidate[]> {
    const jq =
      '.[] | [(.repository.full_name // ""), (.subject.type // ""), (.reason // ""), (.subject.title // ""), (.subject.url // ""), (.latest_comment_url // ""), (.updated_at // "")] | @tsv';
    const stdout = await this.runChecked(
      "read recent notifications",
      [
        "api",
        "/notifications?all=true&participating=false&per_page=100",
        "--paginate",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        "--jq",
        jq,
      ],
      "core",
    );
    const tasks: TaskCandidate[] = [];
    for (const line of stdout.split("\n")) {
      if (line.trim().length === 0) continue;
      const fields = parseTsvLine(line);
      if (fields.length < 7) continue;
      const candidate = buildNotificationCandidate({
        host: this.host,
        repo: fields[0],
        subjectType: fields[1],
        reason: fields[2],
        title: fields[3],
        apiUrl: fields[4],
        latestCommentApiUrl: fields[5],
        updatedAt: fields[6],
      });
      if (!candidate) continue;
      if (!this.repoFilter.matchesRepo(candidate.repo)) continue;
      if (!isRecentGithubTimestamp(candidate.updatedAt, nowEpoch, lookbackSecs)) {
        continue;
      }
      tasks.push(candidate);
    }
    return tasks;
  }

  /** `gh search prs --review-requested=@me`. */
  async reviewRequests(limit: number): Promise<TaskCandidate[]> {
    const jq =
      '.[] | [(.repository.nameWithOwner // ""), ((.number | tostring) // "0"), (.title // ""), (.url // ""), (.updatedAt // "")] | @tsv';
    const tasks: TaskCandidate[] = [];
    for (const scope of searchScopesFor(this.repoFilter)) {
      const stdout = await this.runChecked(
        "search review requests",
        withSearchScope(
          [
            "search",
            "prs",
            "--review-requested=@me",
            "--state",
            "open",
            "--limit",
            String(limit),
            "--json",
            "number,title,url,updatedAt,repository",
            "--jq",
            jq,
          ],
          scope,
        ),
        "search",
      );
      for (const line of stdout.split("\n")) {
        if (line.trim().length === 0) continue;
        const fields = parseTsvLine(line);
        if (fields.length < 5) continue;
        const number = Number.parseInt(fields[1], 10) || 0;
        tasks.push(
          buildReviewRequestCandidate({
            repo: fields[0],
            number,
            title: fields[2],
            webUrl: fields[3],
            updatedAt: fields[4],
          }),
        );
      }
    }
    return deduplicate(tasks);
  }

  /** `gh search issues --assignee=@me --include-prs`. */
  async assignedItems(limit: number): Promise<TaskCandidate[]> {
    const jq =
      '.[] | [(.repository.nameWithOwner // ""), ((.number | tostring) // "0"), (.title // ""), (.url // ""), (.updatedAt // ""), (if .isPullRequest then "1" else "0" end)] | @tsv';
    const tasks: TaskCandidate[] = [];
    for (const scope of searchScopesFor(this.repoFilter)) {
      const stdout = await this.runChecked(
        "search assigned items",
        withSearchScope(
          [
            "search",
            "issues",
            "--assignee=@me",
            "--state",
            "open",
            "--include-prs",
            "--limit",
            String(limit),
            "--json",
            "number,title,url,updatedAt,repository,isPullRequest",
            "--jq",
            jq,
          ],
          scope,
        ),
        "search",
      );
      for (const line of stdout.split("\n")) {
        if (line.trim().length === 0) continue;
        const fields = parseTsvLine(line);
        if (fields.length < 6) continue;
        const number = Number.parseInt(fields[1], 10) || 0;
        tasks.push(
          buildAssignedCandidate({
            repo: fields[0],
            number,
            title: fields[2],
            webUrl: fields[3],
            updatedAt: fields[4],
            isPullRequest: fields[5] === "1",
          }),
        );
      }
    }
    return deduplicate(tasks);
  }

  /** Last comment on `api_url`'s thread (empty api_url → null). */
  async latestCommentActivity(apiUrl: string): Promise<ThreadActivity | null> {
    if (apiUrl.trim().length === 0) return null;
    const jq =
      '[.user.login // "", .user.type // "", (.updated_at // .created_at // "")] | @tsv';
    const stdout = await this.runChecked(
      "inspect latest comment activity",
      ["api", canonicalApiPath(apiUrl), "--jq", jq],
      "core",
    );
    return parseThreadActivity(firstNonEmptyLine(stdout));
  }

  /** Last review on a PR. */
  async latestReviewActivity(
    repo: string,
    prNumber: number,
  ): Promise<ThreadActivity | null> {
    const jq =
      'if length == 0 then empty else .[-1] | [(.user.login // ""), (.user.type // ""), (.submitted_at // "")] | @tsv end';
    const stdout = await this.runChecked(
      "inspect latest review activity",
      [
        "api",
        `/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`,
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        "--jq",
        jq,
      ],
      "core",
    );
    return parseThreadActivity(firstNonEmptyLine(stdout));
  }

  /** Max(latest comment, latest review). */
  async latestVisibleActivity(
    task: TaskCandidate,
  ): Promise<ThreadActivity | null> {
    const comment = await this.latestCommentActivity(task.latestCommentApiUrl);
    const pr = taskPrNumber(task);
    const review =
      pr !== undefined ? await this.latestReviewActivity(task.repo, pr) : null;
    return pickNewerActivity(comment, review);
  }

  /**
   * Top-level candidate producer used by the dispatcher. Runs the
   * notification poll and (optionally) the two search queries,
   * aggregates, de-dups by thread_key, sorts.
   */
  async collectCandidates(options: {
    limit: number;
    includeSearch: boolean;
    nowEpoch: number;
    lookbackSecs: number;
  }): Promise<CandidatePoll> {
    const poll: CandidatePoll = {
      tasks: [],
      warnings: [],
      searchAttempted: false,
      searchRateLimited: false,
    };

    try {
      const tasks = await this.recentNotifications(
        options.nowEpoch,
        options.lookbackSecs,
      );
      poll.tasks.push(...tasks);
    } catch (err) {
      poll.warnings.push(
        `notifications: ${errMessage(err).trim()}`,
      );
    }

    if (options.includeSearch) {
      poll.searchAttempted = true;

      try {
        const tasks = await this.reviewRequests(options.limit);
        poll.tasks.push(...tasks);
      } catch (err) {
        const message = errMessage(err);
        if (isRateLimitError(message)) poll.searchRateLimited = true;
        poll.warnings.push(`review search: ${message.trim()}`);
      }

      try {
        const tasks = await this.assignedItems(options.limit);
        poll.tasks.push(...tasks);
      } catch (err) {
        const message = errMessage(err);
        if (isRateLimitError(message)) poll.searchRateLimited = true;
        poll.warnings.push(`assignment search: ${message.trim()}`);
      }
    }

    poll.tasks = poll.tasks.filter(
      (task) =>
        this.repoFilter.matchesRepo(task.repo) &&
        isRecentGithubTimestamp(task.updatedAt, options.nowEpoch, options.lookbackSecs),
    );
    poll.tasks.sort(compareCandidates);
    poll.tasks = deduplicate(poll.tasks);
    return poll;
  }

  /**
   * Write local snapshot files for a task under `<taskDir>/snapshot/`.
   * Agents read these first to avoid redundant `gh` calls.
   */
  async writeTaskSnapshot(
    task: TaskCandidate,
    taskDir: string,
  ): Promise<string> {
    const snapshotDir = join(taskDir, "snapshot");
    mkdirSync(snapshotDir, { recursive: true });

    const summaryLines = [
      `repo=${task.repo}`,
      `thread_key=${task.threadKey}`,
      `kind=${task.kind}`,
      `title=${task.title}`,
      `url=${taskUrl(task)}`,
      `api_url=${task.apiUrl}`,
      `latest_comment_api_url=${task.latestCommentApiUrl}`,
      `updated_at=${task.updatedAt}`,
    ];
    writeFileSync(join(snapshotDir, "task-summary.env"), summaryLines.join("\n"));
    writeFileSync(
      join(snapshotDir, "README.txt"),
      renderSnapshotReadme(task, snapshotDir),
    );

    if (task.apiUrl.length > 0) {
      await this.captureSnapshot(snapshotDir, "subject.json", {
        context: "hydrate task subject",
        envs: this.hostEnv(),
        args: [
          "api",
          canonicalApiPath(task.apiUrl),
          "-H",
          "X-GitHub-Api-Version: 2022-11-28",
        ],
        bucket: "core",
        mutating: false,
      });
    }
    if (task.latestCommentApiUrl.length > 0) {
      await this.captureSnapshot(snapshotDir, "latest-comment.json", {
        context: "hydrate latest comment",
        envs: this.hostEnv(),
        args: [
          "api",
          canonicalApiPath(task.latestCommentApiUrl),
          "-H",
          "X-GitHub-Api-Version: 2022-11-28",
        ],
        bucket: "core",
        mutating: false,
      });
    }

    const prNumber = taskPrNumber(task);
    const issueNumber = taskIssueNumber(task);
    if (prNumber !== undefined) {
      await this.captureSnapshot(snapshotDir, "pr-view.json", {
        context: "hydrate pr view",
        envs: this.hostEnv(),
        args: [
          "pr",
          "view",
          String(prNumber),
          "--repo",
          task.repo,
          "--json",
          "number,title,body,author,headRefName,headRefOid,baseRefName,url,isDraft,state",
        ],
        bucket: "core",
        mutating: false,
      });
      await this.captureSnapshot(snapshotDir, "pr.diff", {
        context: "hydrate pr diff",
        envs: this.hostEnv(),
        args: ["pr", "diff", String(prNumber), "--repo", task.repo],
        bucket: "core",
        mutating: false,
      });
      await this.captureSnapshot(snapshotDir, "issue-comments.json", {
        context: "hydrate issue comments",
        envs: this.hostEnv(),
        args: [
          "api",
          `/repos/${task.repo}/issues/${prNumber}/comments?per_page=100`,
          "-H",
          "X-GitHub-Api-Version: 2022-11-28",
        ],
        bucket: "core",
        mutating: false,
      });
      await this.captureSnapshot(snapshotDir, "pr-reviews.json", {
        context: "hydrate pr reviews",
        envs: this.hostEnv(),
        args: [
          "api",
          `/repos/${task.repo}/pulls/${prNumber}/reviews?per_page=100`,
          "-H",
          "X-GitHub-Api-Version: 2022-11-28",
        ],
        bucket: "core",
        mutating: false,
      });
    } else if (issueNumber !== undefined) {
      await this.captureSnapshot(snapshotDir, "issue-view.json", {
        context: "hydrate issue view",
        envs: this.hostEnv(),
        args: [
          "issue",
          "view",
          String(issueNumber),
          "--repo",
          task.repo,
          "--json",
          "number,title,body,author,labels,assignees,state,url",
        ],
        bucket: "core",
        mutating: false,
      });
      await this.captureSnapshot(snapshotDir, "issue-comments.json", {
        context: "hydrate issue comments",
        envs: this.hostEnv(),
        args: [
          "api",
          `/repos/${task.repo}/issues/${issueNumber}/comments?per_page=100`,
          "-H",
          "X-GitHub-Api-Version: 2022-11-28",
        ],
        bucket: "core",
        mutating: false,
      });
    }

    return snapshotDir;
  }

  private async captureSnapshot(
    snapshotDir: string,
    filename: string,
    spec: Omit<GhCommandSpec, "cwd"> & { envs: Record<string, string> },
  ): Promise<void> {
    const output = await this.executor.run(spec);
    writeFileSync(join(snapshotDir, filename), output.stdout);
    const metaLines = [
      `context=${spec.context}`,
      `command=${spec.args.map(shellQuote).join(" ")}`,
      `status_code=${output.statusCode}`,
      `bucket=${spec.bucket ?? bucketForArgs(spec.args)}`,
      `mutating=${spec.mutating ?? false}`,
    ];
    if (output.stderr.trim().length > 0) {
      const stderrPath = join(snapshotDir, `${filename}.stderr`);
      writeFileSync(stderrPath, output.stderr);
      metaLines.push(`stderr_file=${stderrPath}`);
    }
    metaLines.push(
      output.statusCode === 0
        ? "snapshot_status=ok"
        : "snapshot_status=partial",
    );
    writeFileSync(join(snapshotDir, `${filename}.meta`), metaLines.join("\n"));
  }

  private async runChecked(
    context: string,
    args: string[],
    bucket: GhBucket,
  ): Promise<string> {
    return this.executor.runChecked({
      context,
      envs: this.hostEnv(),
      args,
      bucket,
      mutating: false,
    });
  }

  private hostEnv(): Record<string, string> {
    return { GH_HOST: this.host };
  }
}

/* ------------------------- utilities -------------------------------- */

export function parseThreadActivity(line: string | undefined): ThreadActivity | null {
  if (!line) return null;
  const fields = parseTsvLine(line);
  if (fields.length < 3) return null;
  return { login: fields[0], userType: fields[1], updatedAt: fields[2] };
}

export function pickNewerActivity(
  left: ThreadActivity | null,
  right: ThreadActivity | null,
): ThreadActivity | null {
  if (left && right) return right.updatedAt > left.updatedAt ? right : left;
  return left ?? right;
}

export function deduplicate(tasks: TaskCandidate[]): TaskCandidate[] {
  const seen = new Set<string>();
  const unique: TaskCandidate[] = [];
  for (const task of tasks) {
    if (seen.has(task.threadKey)) continue;
    seen.add(task.threadKey);
    unique.push(task);
  }
  return unique;
}

/** Skip mentions from self+bot; skip comment/other self-authored events. */
export function shouldIgnoreSelfAuthored(
  login: string,
  latestCommentAuthor: string | undefined,
  kind: TaskCandidate["kind"],
): boolean {
  switch (kind) {
    case "review_request":
    case "assigned_issue":
    case "assigned_pull_request":
      return false;
    case "mention":
      return latestCommentAuthor?.endsWith("[bot]") ?? false;
    default:
      if (!latestCommentAuthor) return false;
      return (
        latestCommentAuthor === login ||
        latestCommentAuthor.endsWith("[bot]")
      );
  }
}

/** Ignore a thread when its latest visible activity was us (or a bot) and is current. */
export function shouldIgnoreLatestSelfActivity(
  login: string,
  activity: ThreadActivity | null,
  taskUpdatedAt: string,
): boolean {
  if (!activity) return false;
  if (activity.updatedAt < taskUpdatedAt) return false;
  const actorLogin = activity.login.trim();
  if (actorLogin.length === 0) return false;
  return (
    actorLogin === login ||
    actorLogin.endsWith("[bot]") ||
    activity.userType === "Bot"
  );
}

/** Mirrors Rust `is_rate_limit_error`: surfaces message-only secondary rate-limit detection. */
export function isRateLimitError(message: string): boolean {
  return isRateLimited({ stdout: "", stderr: message, statusCode: 1 });
}

function withSearchScope(base: string[], scope: SearchScope): string[] {
  switch (scope.kind) {
    case "all":
      return base;
    case "owner":
      return [...base, "--owner", scope.owner];
    case "repo":
      return [...base, "--repo", scope.repo];
  }
}

function compareCandidates(a: TaskCandidate, b: TaskCandidate): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.threadKey.localeCompare(b.threadKey);
}

function firstNonEmptyLine(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    if (line.trim().length > 0) return line;
  }
  return undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderSnapshotReadme(task: TaskCandidate, snapshotDir: string): string {
  return (
    "breeze-runner prepared this local snapshot before the agent started.\n" +
    "\n" +
    "Use these files first to avoid redundant GitHub API calls.\n" +
    "\n" +
    `- Task summary: ${join(snapshotDir, "task-summary.env")}\n` +
    `- Primary subject payload: ${join(snapshotDir, "subject.json")}\n` +
    `- Latest comment payload: ${join(snapshotDir, "latest-comment.json")}\n` +
    "- PR or issue material is stored next to those files when available.\n" +
    "\n" +
    "If you still need `gh`, breeze-runner will broker and pace the command automatically.\n" +
    "\n" +
    `Task: ${task.kind} in ${task.repo}\n` +
    `Title: ${task.title}\n` +
    `URL: ${taskUrl(task)}\n`
  );
}

export { type GhBucket } from "./gh-executor.js";
