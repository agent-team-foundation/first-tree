import { afterEach, describe, expect, it, vi } from "vitest";

describe("Context Reviewer PR internals", () => {
  afterEach(() => {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  });

  it("classifies supported and unsupported PR webhook triggers", async () => {
    const { contextReviewerPrTestInternals, isContextReviewerCandidateEvent } = await import(
      "../services/context-reviewer-pr.js"
    );

    expect(contextReviewerPrTestInternals.isSupportedContextReviewerPrEvent("pull_request", "opened")).toBe(true);
    expect(contextReviewerPrTestInternals.isSupportedContextReviewerPrEvent("pull_request", "closed")).toBe(false);
    expect(isContextReviewerCandidateEvent("pull_request", "reopened")).toBe(true);
    expect(
      isContextReviewerCandidateEvent("pull_request", "edited", {
        action: "edited",
        changes: { body: { from: "old" } },
      }),
    ).toBe(true);
    expect(
      isContextReviewerCandidateEvent("pull_request", "edited", {
        action: "edited",
        changes: { title: { from: "old" } },
      }),
    ).toBe(false);
    expect(isContextReviewerCandidateEvent("issue_comment", "created")).toBe(true);
    expect(isContextReviewerCandidateEvent("issue_comment", "edited")).toBe(false);
    expect(isContextReviewerCandidateEvent("pull_request_review_comment", "edited")).toBe(true);
  });

  it("fails clearly when the prompt template is missing from every runtime layout", async () => {
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        access: vi.fn(async () => {
          throw new Error("missing template");
        }),
        readFile: vi.fn(),
      };
    });
    const { renderContextReviewerPrPrompt } = await import("../services/context-reviewer-pr.js");

    await expect(
      renderContextReviewerPrPrompt({
        repoFullName: "owner/context-tree",
        prNumber: 1,
        title: "Missing template",
        htmlUrl: "https://github.com/owner/context-tree/pull/1",
        baseRef: null,
        headRef: null,
        authorLogin: "writer",
        senderLogin: "writer",
        triggerEvent: "pull_request.opened",
        isDraft: false,
        commentUrl: null,
        commentAuthorLogin: null,
        organizationId: "org_1",
        contextReviewRunId: "01900000-0000-7000-8000-000000000001",
        contextReviewHeadSha: "a".repeat(40),
        reviewerManagerGithubLogin: null,
      }),
    ).rejects.toThrow("Context Reviewer PR prompt template is missing");
  });
});
