import { describe, expect, it } from "vitest";

import {
  buildAssignedCandidate,
  buildNotificationCandidate,
  buildReviewRequestCandidate,
  candidateFromTaskMetadata,
  displayUrl,
  effectiveWorkspaceRepo,
  stableIdFor,
  taskIssueNumber,
  taskPrNumber,
  taskUrl,
  threadRecordFromKv,
  threadRecordToLines,
  toDispatcherCandidate,
  type ThreadRecord,
} from "../../src/products/breeze/engine/runtime/task.js";

describe("buildNotificationCandidate", () => {
  it("extracts pr number and sets review-request priority for review_requested", () => {
    const candidate = buildNotificationCandidate({
      host: "github.com",
      repo: "owner/repo",
      subjectType: "PullRequest",
      reason: "review_requested",
      title: "Review me",
      apiUrl: "https://api.github.com/repos/owner/repo/pulls/12",
      latestCommentApiUrl: "",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(candidate).toBeDefined();
    expect(candidate!.kind).toBe("review_request");
    expect(candidate!.priority).toBe(100);
    expect(candidate!.threadKey).toBe("/repos/owner/repo/pulls/12");
    expect(taskPrNumber(candidate!)).toBe(12);
  });

  it("builds candidates for mentions referencing comments with anchor urls", () => {
    const candidate = buildNotificationCandidate({
      host: "github.com",
      repo: "agent-team-foundation/first-tree",
      subjectType: "PullRequest",
      reason: "mention",
      title: "fix(sync): ...",
      apiUrl: "https://api.github.com/repos/agent-team-foundation/first-tree/pulls/98",
      latestCommentApiUrl:
        "https://api.github.com/repos/agent-team-foundation/first-tree/issues/comments/4247540715",
      updatedAt: "2026-04-14T22:18:56Z",
    });
    expect(candidate!.kind).toBe("mention");
    expect(taskPrNumber(candidate!)).toBe(98);
    expect(taskUrl(candidate!)).toBe(
      "https://github.com/agent-team-foundation/first-tree/pull/98#issuecomment-4247540715",
    );
  });

  it("returns undefined for non-actionable reasons", () => {
    const out = buildNotificationCandidate({
      host: "github.com",
      repo: "o/r",
      subjectType: "PullRequest",
      reason: "subscribed",
      title: "x",
      apiUrl: "https://api.github.com/repos/o/r/pulls/1",
      latestCommentApiUrl: "",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(out).toBeUndefined();
  });

  it("returns undefined when repo is empty", () => {
    const out = buildNotificationCandidate({
      host: "github.com",
      repo: "",
      subjectType: "PullRequest",
      reason: "mention",
      title: "x",
      apiUrl: "",
      latestCommentApiUrl: "",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(out).toBeUndefined();
  });

  it("falls back to the issue web url when no comment anchor is available", () => {
    const candidate = buildNotificationCandidate({
      host: "github.com",
      repo: "o/r",
      subjectType: "Issue",
      reason: "comment",
      title: "t",
      apiUrl: "https://api.github.com/repos/o/r/issues/7",
      latestCommentApiUrl: "",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(taskUrl(candidate!)).toBe("https://github.com/o/r/issues/7");
  });
});

describe("buildReviewRequestCandidate / buildAssignedCandidate", () => {
  it("review request builds with pulls thread key + priority 100", () => {
    const c = buildReviewRequestCandidate({
      repo: "o/r",
      number: 45,
      title: "Handle review",
      webUrl: "https://github.com/o/r/pull/45",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(c.threadKey).toBe("/repos/o/r/pulls/45");
    expect(c.priority).toBe(100);
    expect(taskPrNumber(c)).toBe(45);
  });

  it("assigned issue vs pr is driven by isPullRequest", () => {
    const issue = buildAssignedCandidate({
      repo: "o/r",
      number: 3,
      title: "t",
      webUrl: "u",
      updatedAt: "u",
      isPullRequest: false,
    });
    expect(issue.kind).toBe("assigned_issue");
    expect(taskIssueNumber(issue)).toBe(3);

    const pr = buildAssignedCandidate({
      repo: "o/r",
      number: 4,
      title: "t",
      webUrl: "u",
      updatedAt: "u",
      isPullRequest: true,
    });
    expect(pr.kind).toBe("assigned_pull_request");
    expect(taskPrNumber(pr)).toBe(4);
  });
});

describe("candidateFromTaskMetadata", () => {
  it("derives api/web urls from thread_key for /repos/... entries", () => {
    const meta = new Map<string, string>([
      ["repo", "owner/repo"],
      ["workspace_repo", "bingran-you/bingran-you"],
      ["thread_key", "/repos/owner/repo/pulls/12"],
      ["kind", "review_request"],
      ["reason", "review_requested"],
      ["title", "Recover me"],
      ["updated_at", "2026-01-01T00:00:00Z"],
      ["source", "review-search"],
    ]);
    const c = candidateFromTaskMetadata(meta, "github.com");
    expect(c).toBeDefined();
    expect(c!.kind).toBe("review_request");
    expect(c!.apiUrl).toBe("https://api.github.com/repos/owner/repo/pulls/12");
    expect(c!.webUrl).toBe("https://github.com/owner/repo/pull/12");
    expect(effectiveWorkspaceRepo(c!)).toBe("bingran-you/bingran-you");
  });

  it("returns undefined when required fields are missing", () => {
    expect(
      candidateFromTaskMetadata(new Map([["kind", "mention"]]), "github.com"),
    ).toBeUndefined();
  });
});

describe("stableIdFor", () => {
  it("is deterministic across equal candidates", () => {
    const base = buildReviewRequestCandidate({
      repo: "o/r",
      number: 1,
      title: "t",
      webUrl: "u",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(stableIdFor(base)).toBe(stableIdFor({ ...base }));
    expect(stableIdFor(base)).toHaveLength(16);
  });
});

describe("toDispatcherCandidate", () => {
  it("exposes the minimal dispatcher shape including prNumber", () => {
    const c = buildReviewRequestCandidate({
      repo: "o/r",
      number: 42,
      title: "Review",
      webUrl: "https://github.com/o/r/pull/42",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const disp = toDispatcherCandidate(c);
    expect(disp.prNumber).toBe(42);
    expect(disp.stableId).toBe(disp.notificationId);
    expect(disp.threadKey).toBe("/repos/o/r/pulls/42");
    expect(disp.priority).toBe(100);
  });
});

describe("ThreadRecord serialization", () => {
  it("round-trips through to-lines/from-kv", () => {
    const record: ThreadRecord = {
      threadKey: "/repos/o/r/issues/1",
      repo: "o/r",
      lastSeenUpdatedAt: "2026-01-01T00:00:00Z",
      lastHandledUpdatedAt: "2026-01-01T00:00:00Z",
      lastResult: "handled",
      failureCount: 2,
      nextRetryEpoch: 1234,
      lastTaskId: "task-1",
    };
    const lines = threadRecordToLines(record);
    const kv: Array<[string, string]> = lines.map((line) => {
      const eq = line.indexOf("=");
      return [line.slice(0, eq), line.slice(eq + 1)];
    });
    const restored = threadRecordFromKv(kv);
    expect(restored).toEqual(record);
  });

  it("preserves newlines in multiline values via encode/decode", () => {
    const record: ThreadRecord = {
      threadKey: "k",
      repo: "o/r",
      lastSeenUpdatedAt: "",
      lastHandledUpdatedAt: "",
      lastResult: "line1\nline2",
      failureCount: 0,
      nextRetryEpoch: 0,
      lastTaskId: "",
    };
    const lines = threadRecordToLines(record);
    const kv = lines.map((line) => {
      const eq = line.indexOf("=");
      return [line.slice(0, eq), line.slice(eq + 1)] as [string, string];
    });
    expect(threadRecordFromKv(kv).lastResult).toBe("line1\nline2");
  });
});

describe("displayUrl fallback", () => {
  it("returns webUrl when present, else apiUrl", () => {
    const c = buildReviewRequestCandidate({
      repo: "o/r",
      number: 1,
      title: "",
      webUrl: "https://github.com/o/r/pull/1",
      updatedAt: "",
    });
    expect(displayUrl(c)).toBe("https://github.com/o/r/pull/1");
    const cNoWeb = { ...c, webUrl: "" };
    expect(displayUrl(cNoWeb)).toBe(
      "https://api.github.com/repos/o/r/pulls/1",
    );
  });
});
