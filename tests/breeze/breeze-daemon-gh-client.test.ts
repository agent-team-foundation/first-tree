import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GhClient,
  deduplicate,
  isRateLimitError,
  parseThreadActivity,
  pickNewerActivity,
  shouldIgnoreLatestSelfActivity,
  shouldIgnoreSelfAuthored,
} from "../../src/products/breeze/engine/daemon/gh-client.js";
import {
  GhExecutor,
  type ExecOutput,
  type GhCommandSpec,
} from "../../src/products/breeze/engine/daemon/gh-executor.js";
import { RepoFilter } from "../../src/products/breeze/engine/runtime/repo-filter.js";
import {
  buildNotificationCandidate,
  buildRequiredReviewCandidate,
  buildReviewRequestCandidate,
} from "../../src/products/breeze/engine/runtime/task.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `breeze-gh-client-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

interface StubExecutor {
  calls: GhCommandSpec[];
  setResponses(responses: Array<Partial<ExecOutput>>): void;
  setResponder(fn: (spec: GhCommandSpec) => Partial<ExecOutput>): void;
}

function makeStubExecutor(): { executor: GhExecutor; ctl: StubExecutor } {
  const calls: GhCommandSpec[] = [];
  let queue: Array<Partial<ExecOutput>> = [];
  let responder:
    | ((spec: GhCommandSpec) => Partial<ExecOutput>)
    | undefined;
  // Virtual clock that advances with each injected sleep. This lets
  // the executor's rate-limit backoff path terminate in tests.
  let nowMs = 1_000_000;
  const executor = new GhExecutor({
    realGh: "/usr/bin/gh",
    writeCooldownMs: 0,
    spawnGh: async (spec) => {
      calls.push(spec);
      const out = responder
        ? responder(spec)
        : queue.shift() ?? { stdout: "", stderr: "", statusCode: 0 };
      return {
        stdout: out.stdout ?? "",
        stderr: out.stderr ?? "",
        statusCode: out.statusCode ?? 0,
      };
    },
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
  });
  return {
    executor,
    ctl: {
      calls,
      setResponses(responses) {
        queue = [...responses];
      },
      setResponder(fn) {
        responder = fn;
      },
    },
  };
}

describe("GhClient.recentNotifications", () => {
  it("parses @tsv output and applies repo filter + lookback", async () => {
    const { executor, ctl } = makeStubExecutor();
    // Two tab-separated rows: first passes filter + recent; second is filtered out.
    ctl.setResponses([
      {
        stdout: [
          "owner/repo\tPullRequest\tmention\tHello\thttps://api.github.com/repos/owner/repo/pulls/7\t\t2026-04-15T12:00:00Z",
          "other/repo\tIssue\tmention\tSkip\thttps://api.github.com/repos/other/repo/issues/3\t\t2026-04-15T12:00:00Z",
        ].join("\n"),
      },
    ]);
    const client = new GhClient({
      host: "github.com",
      repoFilter: RepoFilter.parseCsv("owner/*"),
      executor,
    });
    const now = Date.UTC(2026, 3, 15, 12, 0, 0) / 1000; // 2026-04-15T12:00:00Z
    const tasks = await client.recentNotifications(now, 120);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].repo).toBe("owner/repo");
    expect(tasks[0].kind).toBe("mention");
    // Assert the argv sent to gh contains the paginate + notifications endpoint.
    expect(ctl.calls[0].args).toContain("--paginate");
    expect(ctl.calls[0].args).toContain("/notifications?all=true&participating=false&per_page=100");
  });

  it("drops lines that predate the lookback window", async () => {
    const { executor, ctl } = makeStubExecutor();
    ctl.setResponses([
      {
        stdout:
          "owner/repo\tPullRequest\tmention\tOld\thttps://api.github.com/repos/owner/repo/pulls/7\t\t2026-04-01T00:00:00Z",
      },
    ]);
    const client = new GhClient({
      host: "github.com",
      repoFilter: RepoFilter.empty(),
      executor,
    });
    const now = Date.UTC(2026, 3, 15, 12, 0, 0) / 1000;
    const tasks = await client.recentNotifications(now, 60);
    expect(tasks).toEqual([]);
  });
});

describe("GhClient.reviewRequests / assignedItems", () => {
  it("fans out one call per search scope", async () => {
    const { executor, ctl } = makeStubExecutor();
    ctl.setResponder((spec) => {
      if (spec.args[0] === "search" && spec.args[1] === "prs") {
        return {
          stdout: "o/r\t11\tReview me\thttps://github.com/o/r/pull/11\t2026-04-15T12:00:00Z",
        };
      }
      return { stdout: "" };
    });
    const client = new GhClient({
      host: "github.com",
      repoFilter: RepoFilter.parseCsv("o/*,p/r"),
      executor,
    });
    const tasks = await client.reviewRequests(10);
    // Two scopes (owner "o", repo "p/r") → two calls; both return the same
    // payload, so dedupe trims to one.
    expect(ctl.calls.length).toBe(2);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].kind).toBe("review_request");
  });

  it("parses the isPullRequest flag for assigned items", async () => {
    const { executor, ctl } = makeStubExecutor();
    ctl.setResponses([
      {
        stdout: [
          "o/r\t3\tBug\thttps://github.com/o/r/issues/3\t2026-04-15T12:00:00Z\t0",
          "o/r\t4\tFeature\thttps://github.com/o/r/pull/4\t2026-04-15T12:00:00Z\t1",
        ].join("\n"),
      },
    ]);
    const client = new GhClient({
      host: "github.com",
      repoFilter: RepoFilter.empty(),
      executor,
    });
    const tasks = await client.assignedItems(10);
    expect(tasks.map((t) => t.kind)).toEqual([
      "assigned_issue",
      "assigned_pull_request",
    ]);
  });

  it("falls back to issue comments for search-derived PR candidates", async () => {
    const { executor, ctl } = makeStubExecutor();
    ctl.setResponder((spec) => {
      if (spec.args[0] === "api" && String(spec.args[1]).includes("/issues/45/comments")) {
        return {
          stdout: "alice\tUser\t2026-04-15T12:00:00Z",
        };
      }
      if (spec.args[0] === "api" && String(spec.args[1]).includes("/pulls/45/reviews")) {
        return { stdout: "" };
      }
      return { stdout: "" };
    });
    const client = new GhClient({
      host: "github.com",
      repoFilter: RepoFilter.empty(),
      executor,
    });
    const activity = await client.latestVisibleActivity(
      buildRequiredReviewCandidate({
        repo: "o/r",
        number: 45,
        title: "Handle backlog",
        webUrl: "https://github.com/o/r/pull/45",
        updatedAt: "2026-04-15T12:00:00Z",
      }),
    );
    expect(activity).toEqual({
      login: "alice",
      userType: "User",
      updatedAt: "2026-04-15T12:00:00Z",
    });
  });

  it("recovers required-review backlog from exact repo scopes", async () => {
    const { executor, ctl } = makeStubExecutor();
    ctl.setResponses([
      {
        stdout: [
          "45\tHandle backlog\thttps://github.com/o/r/pull/45\t2026-04-15T12:00:00Z\t0\tREVIEW_REQUIRED",
          "46\tSkip draft\thttps://github.com/o/r/pull/46\t2026-04-15T12:00:00Z\t1\tREVIEW_REQUIRED",
          "47\tSkip changes requested\thttps://github.com/o/r/pull/47\t2026-04-15T12:00:00Z\t0\tCHANGES_REQUESTED",
        ].join("\n"),
      },
    ]);
    const client = new GhClient({
      host: "github.com",
      repoFilter: RepoFilter.parseCsv("o/r"),
      executor,
    });
    const tasks = await client.requiredReviewBacklog(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual(
      buildRequiredReviewCandidate({
        repo: "o/r",
        number: 45,
        title: "Handle backlog",
        webUrl: "https://github.com/o/r/pull/45",
        updatedAt: "2026-04-15T12:00:00Z",
      }),
    );
    expect(ctl.calls[0].args.slice(0, 2)).toEqual(["pr", "list"]);
    expect(ctl.calls[0].args).toContain("--repo");
    expect(ctl.calls[0].args).toContain("o/r");
  });
});

describe("GhClient.collectCandidates", () => {
  it("captures warnings but continues when notifications fail", async () => {
    const { executor, ctl } = makeStubExecutor();
    ctl.setResponder((spec) => {
      if (spec.args[0] === "api") {
        return { statusCode: 1, stderr: "notifications boom" };
      }
      if (spec.args[0] === "search" && spec.args[1] === "prs") {
        return {
          stdout: "o/r\t11\tReview me\thttps://github.com/o/r/pull/11\t2026-04-15T12:00:00Z",
        };
      }
      return { stdout: "" };
    });
    const client = new GhClient({
      host: "github.com",
      repoFilter: RepoFilter.empty(),
      executor,
    });
    const now = Date.UTC(2026, 3, 15, 12, 0, 0) / 1000;
    const poll = await client.collectCandidates({
      limit: 5,
      includeSearch: true,
      nowEpoch: now,
      lookbackSecs: 3600,
    });
    expect(poll.warnings.length).toBeGreaterThan(0);
    expect(poll.warnings[0]).toMatch(/notifications:/);
    expect(poll.tasks.length).toBe(1);
    expect(poll.searchAttempted).toBe(true);
  });

  it("marks searchRateLimited when a search error contains a rate-limit signature", async () => {
    const { executor, ctl } = makeStubExecutor();
    ctl.setResponder((spec) => {
      if (spec.args[0] === "api") return { stdout: "" };
      return { statusCode: 1, stderr: "secondary rate limit hit" };
    });
    const client = new GhClient({
      host: "github.com",
      repoFilter: RepoFilter.empty(),
      executor,
    });
    const now = Date.UTC(2026, 3, 15, 12, 0, 0) / 1000;
    const poll = await client.collectCandidates({
      limit: 5,
      includeSearch: true,
      nowEpoch: now,
      lookbackSecs: 3600,
    });
    expect(poll.searchRateLimited).toBe(true);
  });

  it("adds required-review backlog when review-requested search is empty", async () => {
    const { executor, ctl } = makeStubExecutor();
    ctl.setResponder((spec) => {
      if (spec.args[0] === "api") return { stdout: "" };
      if (spec.args[0] === "search" && spec.args.includes("--review-requested=@me")) {
        return { stdout: "" };
      }
      if (spec.args[0] === "pr" && spec.args[1] === "list") {
        return {
          stdout:
            "11\tReview me later\thttps://github.com/o/r/pull/11\t2026-04-15T12:00:00Z\t0\tREVIEW_REQUIRED",
        };
      }
      if (spec.args[0] === "search" && spec.args[1] === "issues") {
        return { stdout: "" };
      }
      return { stdout: "" };
    });
    const client = new GhClient({
      host: "github.com",
      repoFilter: RepoFilter.parseCsv("o/r"),
      executor,
    });
    const now = Date.UTC(2026, 3, 15, 12, 0, 0) / 1000;
    const poll = await client.collectCandidates({
      limit: 5,
      includeSearch: true,
      nowEpoch: now,
      lookbackSecs: 3600,
    });
    expect(poll.tasks).toEqual([
      buildRequiredReviewCandidate({
        repo: "o/r",
        number: 11,
        title: "Review me later",
        webUrl: "https://github.com/o/r/pull/11",
        updatedAt: "2026-04-15T12:00:00Z",
      }),
    ]);
    expect(
      ctl.calls.some((call) => call.args[0] === "pr" && call.args[1] === "list"),
    ).toBe(true);
  });
});

describe("GhClient.writeTaskSnapshot", () => {
  it("writes task-summary + README and an `.meta` file per captured payload", async () => {
    const { executor, ctl } = makeStubExecutor();
    ctl.setResponder((spec) => {
      if (spec.args[0] === "pr" && spec.args[1] === "view") {
        return { stdout: '{"number":42}' };
      }
      return { stdout: "body" };
    });
    const client = new GhClient({
      host: "github.com",
      repoFilter: RepoFilter.empty(),
      executor,
    });
    const candidate = buildReviewRequestCandidate({
      repo: "o/r",
      number: 42,
      title: "Review",
      webUrl: "https://github.com/o/r/pull/42",
      updatedAt: "2026-04-15T12:00:00Z",
    });
    const taskDir = makeTempDir("snapshot");
    const snapshotDir = await client.writeTaskSnapshot(candidate, taskDir);
    const files = readdirSync(snapshotDir).sort();
    expect(files).toContain("task-summary.env");
    expect(files).toContain("README.txt");
    expect(files).toContain("subject.json");
    expect(files).toContain("pr-view.json");
    expect(readFileSync(join(snapshotDir, "pr-view.json"), "utf8")).toBe(
      '{"number":42}',
    );
    // pr-commits.json is required so gardener respond's idempotency
    // check runs in snapshot mode — see #158.
    expect(files).toContain("pr-commits.json");
    // Meta has bucket/status lines.
    const meta = readFileSync(
      join(snapshotDir, "pr-view.json.meta"),
      "utf8",
    );
    expect(meta).toContain("bucket=core");
    expect(meta).toContain("snapshot_status=ok");
  });
});

describe("pure helpers", () => {
  it("parseThreadActivity handles an empty line", () => {
    expect(parseThreadActivity(undefined)).toBeNull();
    expect(parseThreadActivity("a\tUser\t2026-04-15T00:00:00Z")).toEqual({
      login: "a",
      userType: "User",
      updatedAt: "2026-04-15T00:00:00Z",
    });
  });

  it("pickNewerActivity prefers the later updatedAt", () => {
    const left = {
      login: "a",
      userType: "User",
      updatedAt: "2026-04-15T10:00:00Z",
    };
    const right = {
      login: "b",
      userType: "User",
      updatedAt: "2026-04-15T11:00:00Z",
    };
    expect(pickNewerActivity(left, right)).toEqual(right);
    expect(pickNewerActivity(right, null)).toEqual(right);
    expect(pickNewerActivity(null, null)).toBeNull();
  });

  it("deduplicate keeps first occurrence per thread_key", () => {
    const a = buildNotificationCandidate({
      host: "github.com",
      repo: "o/r",
      subjectType: "PullRequest",
      reason: "mention",
      title: "A",
      apiUrl: "https://api.github.com/repos/o/r/pulls/1",
      latestCommentApiUrl: "",
      updatedAt: "2026-04-15T00:00:00Z",
    })!;
    const b = { ...a, title: "B" };
    expect(deduplicate([a, b])).toHaveLength(1);
    expect(deduplicate([a, b])[0].title).toBe("A");
  });

  it("shouldIgnoreSelfAuthored filters comments but not review requests", () => {
    expect(shouldIgnoreSelfAuthored("alice", "alice", "comment")).toBe(true);
    expect(shouldIgnoreSelfAuthored("alice", "alice", "review_request")).toBe(false);
    expect(
      shouldIgnoreSelfAuthored("alice", "github-actions[bot]", "mention"),
    ).toBe(true);
    expect(shouldIgnoreSelfAuthored("alice", "bob", "comment")).toBe(false);
  });

  it("shouldIgnoreLatestSelfActivity compares against the handled watermark", () => {
    const activity = {
      login: "alice",
      userType: "User",
      updatedAt: "2026-04-15T12:00:00Z",
    };
    expect(
      shouldIgnoreLatestSelfActivity("alice", activity, "2026-04-15T12:00:00Z"),
    ).toBe(true);
    expect(
      shouldIgnoreLatestSelfActivity("alice", activity, "2026-04-15T13:00:00Z"),
    ).toBe(false);
  });

  it("isRateLimitError detects secondary/abuse substrings", () => {
    expect(isRateLimitError("secondary rate limit triggered")).toBe(true);
    expect(isRateLimitError("something else")).toBe(false);
  });
});
