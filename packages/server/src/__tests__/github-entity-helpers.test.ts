import { describe, expect, it } from "vitest";
import { extractEventEntity, formatEntityTitle, parseFixesRefs, shouldSilent } from "../api/webhooks/github-entity.js";

describe("extractEventEntity", () => {
  it("derives issue entity from issues event", () => {
    const entity = extractEventEntity("issues", {
      issue: { number: 42, title: "Refactor inbox", html_url: "https://github.com/owner/repo/issues/42" },
      repository: { full_name: "owner/repo" },
    });
    expect(entity).toEqual({
      type: "issue",
      key: "owner/repo#42",
      title: "Refactor inbox",
      url: "https://github.com/owner/repo/issues/42",
    });
  });

  it("derives issue entity from issue_comment event", () => {
    const entity = extractEventEntity("issue_comment", {
      issue: { number: 7, title: "Comment thread", html_url: "https://github.com/owner/repo/issues/7" },
      repository: { full_name: "owner/repo" },
    });
    expect(entity?.type).toBe("issue");
    expect(entity?.key).toBe("owner/repo#7");
  });

  it("derives pull_request entity from pull_request event", () => {
    const entity = extractEventEntity("pull_request", {
      pull_request: { number: 50, title: "Implement refactor", html_url: "https://github.com/owner/repo/pull/50" },
      repository: { full_name: "owner/repo" },
    });
    expect(entity).toEqual({
      type: "pull_request",
      key: "owner/repo#50",
      title: "Implement refactor",
      url: "https://github.com/owner/repo/pull/50",
    });
  });

  it("derives pull_request entity from pull_request_review_comment event", () => {
    const entity = extractEventEntity("pull_request_review_comment", {
      pull_request: { number: 50, title: "Implement refactor", html_url: "https://github.com/owner/repo/pull/50" },
      repository: { full_name: "owner/repo" },
    });
    expect(entity?.type).toBe("pull_request");
  });

  it("derives discussion entity using discussion number", () => {
    const entity = extractEventEntity("discussion", {
      discussion: { number: 9, title: "RFC", html_url: "https://github.com/owner/repo/discussions/9" },
      repository: { full_name: "owner/repo" },
    });
    expect(entity).toEqual({
      type: "discussion",
      key: "owner/repo#discussion-9",
      title: "RFC",
      url: "https://github.com/owner/repo/discussions/9",
    });
  });

  it("derives commit entity from commit_comment with commit_id", () => {
    const entity = extractEventEntity("commit_comment", {
      comment: { commit_id: "abc1234", html_url: "https://github.com/owner/repo/commit/abc1234" },
      repository: { full_name: "owner/repo" },
    });
    expect(entity).toEqual({
      type: "commit",
      key: "owner/repo@abc1234",
      url: "https://github.com/owner/repo/commit/abc1234",
    });
  });

  it("returns null for unknown event types", () => {
    expect(extractEventEntity("workflow_run", { repository: { full_name: "owner/repo" } })).toBeNull();
  });

  it("returns null when repository is missing", () => {
    expect(extractEventEntity("issues", { issue: { number: 1 } })).toBeNull();
  });

  it("returns null when issue/PR number is malformed", () => {
    expect(
      extractEventEntity("issues", { issue: { number: "abc" }, repository: { full_name: "owner/repo" } }),
    ).toBeNull();
  });
});

describe("parseFixesRefs", () => {
  it("parses Fixes #N", () => {
    expect(parseFixesRefs("Fixes #42", "owner/repo")).toEqual([{ type: "issue", key: "owner/repo#42" }]);
  });

  it("parses Closes #N and Resolves #N", () => {
    expect(parseFixesRefs("Closes #1; resolves #2", "owner/repo").map((r) => r.key)).toEqual([
      "owner/repo#1",
      "owner/repo#2",
    ]);
  });

  it("parses all official closing keywords", () => {
    const text = "close #1 closes #2 closed #3 fix #4 fixes #5 fixed #6 resolve #7 resolves #8 resolved #9";
    expect(parseFixesRefs(text, "owner/repo").map((r) => r.key)).toEqual([
      "owner/repo#1",
      "owner/repo#2",
      "owner/repo#3",
      "owner/repo#4",
      "owner/repo#5",
      "owner/repo#6",
      "owner/repo#7",
      "owner/repo#8",
      "owner/repo#9",
    ]);
  });

  it("is case-insensitive", () => {
    expect(parseFixesRefs("FIXES #42", "owner/repo").map((r) => r.key)).toEqual(["owner/repo#42"]);
  });

  it("deduplicates repeated refs while preserving first-seen order", () => {
    expect(parseFixesRefs("Fixes #1 fixes #2 closes #1", "owner/repo").map((r) => r.key)).toEqual([
      "owner/repo#1",
      "owner/repo#2",
    ]);
  });

  it("returns empty for null / empty input", () => {
    expect(parseFixesRefs(null, "owner/repo")).toEqual([]);
    expect(parseFixesRefs("", "owner/repo")).toEqual([]);
  });

  it("ignores cross-repo references (org/repo#N)", () => {
    // `\b...\s+#(\d+)\b` requires whitespace between the keyword and `#`, so
    // `Fixes another/repo#42` (no space before `#`) fails to match — which
    // matches the design's "v1 不支持 cross-repo" stance for free.
    expect(parseFixesRefs("Fixes another/repo#42", "owner/repo")).toEqual([]);
  });

  it("ignores non-keyword mentions of issue numbers", () => {
    expect(parseFixesRefs("See #42 for context.", "owner/repo")).toEqual([]);
  });
});

describe("formatEntityTitle", () => {
  it("renders Issue title", () => {
    expect(formatEntityTitle({ type: "issue", key: "owner/repo#42", title: "Refactor inbox" })).toBe(
      "Issue owner/repo#42: Refactor inbox",
    );
  });

  it("renders PR title", () => {
    expect(formatEntityTitle({ type: "pull_request", key: "owner/repo#50", title: "Implement refactor" })).toBe(
      "PR owner/repo#50: Implement refactor",
    );
  });

  it("renders Discussion title", () => {
    expect(formatEntityTitle({ type: "discussion", key: "owner/repo#discussion-9", title: "RFC" })).toBe(
      "Discussion owner/repo#discussion-9: RFC",
    );
  });

  it("falls back to key when title is missing", () => {
    expect(formatEntityTitle({ type: "issue", key: "owner/repo#42" })).toBe("Issue owner/repo#42");
  });
});

describe("shouldSilent", () => {
  it("silences workflow_run / check_run / push / release etc.", () => {
    expect(shouldSilent("workflow_run", { action: "completed" })).toBe(true);
    expect(shouldSilent("check_run", { action: "completed" })).toBe(true);
    expect(shouldSilent("push", {})).toBe(true);
    expect(shouldSilent("release", { action: "published" })).toBe(true);
  });

  it("silences Bot senders regardless of event type", () => {
    expect(shouldSilent("issues", { action: "opened", sender: { type: "Bot" } })).toBe(true);
  });

  it("silences pull_request.synchronize (branch push to PR)", () => {
    expect(shouldSilent("pull_request", { action: "synchronize" })).toBe(true);
  });

  it("silences issues label-noise actions", () => {
    expect(shouldSilent("issues", { action: "labeled" })).toBe(true);
    expect(shouldSilent("issues", { action: "milestoned" })).toBe(true);
  });

  it("does NOT silence the core conversation actions", () => {
    expect(shouldSilent("issues", { action: "opened", sender: { type: "User" } })).toBe(false);
    expect(shouldSilent("issue_comment", { action: "created", sender: { type: "User" } })).toBe(false);
    expect(shouldSilent("pull_request", { action: "opened", sender: { type: "User" } })).toBe(false);
    expect(shouldSilent("pull_request", { action: "review_requested", sender: { type: "User" } })).toBe(false);
  });

  it("does NOT silence pull_request.opened when sender type is missing", () => {
    expect(shouldSilent("pull_request", { action: "opened" })).toBe(false);
  });
});
