import { describe, expect, it } from "vitest";
import {
  CONTEXT_REVIEW_BODY_MAX_BYTES,
  CONTEXT_REVIEW_RUN_MARKER_PREFIX,
  contextReviewerRunMessageMetadataSchema,
  contextReviewSubmitRequestSchema,
} from "../schemas/context-review.js";

describe("Context Review schemas", () => {
  it("accepts the complete server-authored run envelope", () => {
    expect(
      contextReviewerRunMessageMetadataSchema.safeParse({
        source: "github",
        contextTreeReviewer: true,
        contextReviewRunId: "run-1",
        contextReviewRepository: "acme/context-tree",
        contextReviewPrNumber: 42,
        contextReviewOrganizationId: "org-1",
        contextReviewReviewerAgentUuid: "reviewer-1",
        contextReviewReviewerManagerHumanAgentId: "human-1",
        contextReviewSubmission: { state: "pending" },
        mentions: ["reviewer-1"],
      }).success,
    ).toBe(true);
  });

  it("accepts a provider-specific GitLab MR run without an App submission state", () => {
    expect(
      contextReviewerRunMessageMetadataSchema.parse({
        source: "gitlab",
        contextTreeReviewer: true,
        contextReviewRunId: "run-2",
        contextReviewRepository: "gitlab.internal/group/subgroup/context-tree",
        contextReviewConnectionId: "connection-1",
        contextReviewProjectId: 123,
        contextReviewMrIid: 42,
        contextReviewEntityUrl: "https://gitlab.internal/group/subgroup/context-tree/-/merge_requests/42",
        contextReviewOrganizationId: "org-1",
        contextReviewReviewerAgentUuid: "reviewer-1",
        contextReviewReviewerManagerHumanAgentId: "human-1",
        mentions: ["reviewer-1"],
      }),
    ).toMatchObject({
      source: "gitlab",
      contextReviewProjectId: 123,
      contextReviewMrIid: 42,
    });
  });

  it.each([
    { state: "pending" },
    {
      state: "submitting",
      payloadHash: "hash",
      attemptId: "attempt-1",
      reviewedHead: "a".repeat(40),
      event: "APPROVE",
      claimedAt: "2026-07-21T00:00:00.000Z",
      reviewerClientId: "client-1",
    },
    {
      state: "unknown",
      payloadHash: "hash",
      attemptId: "attempt-1",
      reviewedHead: "a".repeat(40),
      event: "COMMENT",
      failedAt: "2026-07-21T00:00:00.000Z",
      reviewerClientId: "client-1",
    },
    {
      state: "failed",
      payloadHash: "hash",
      code: "CONTEXT_REVIEW_GITHUB_REJECTED",
      failedAt: "2026-07-21T00:00:00.000Z",
    },
    {
      state: "submitted",
      payloadHash: "hash",
      reviewedHead: "a".repeat(40),
      event: "REQUEST_CHANGES",
      reviewId: 42,
      reviewUrl: "https://github.com/acme/context-tree/pull/42#pullrequestreview-42",
      appActor: "first-tree[bot]",
      submittedAt: "2026-07-21T00:00:00.000Z",
      reviewerAgentUuid: "reviewer-1",
      reviewerManagerHumanAgentId: "human-1",
      reviewerClientId: "client-1",
      reviewerManagerGithubLogin: null,
    },
  ])("accepts the durable $state submission state without losing run trust", (contextReviewSubmission) => {
    expect(
      contextReviewerRunMessageMetadataSchema.safeParse({
        source: "github",
        contextTreeReviewer: true,
        contextReviewRunId: "run-1",
        contextReviewRepository: "acme/context-tree",
        contextReviewPrNumber: 42,
        contextReviewOrganizationId: "org-1",
        contextReviewReviewerAgentUuid: "reviewer-1",
        contextReviewReviewerManagerHumanAgentId: "human-1",
        contextReviewSubmission,
      }).success,
    ).toBe(true);
  });

  it("rejects incomplete or unsupported-provider run envelopes", () => {
    expect(contextReviewerRunMessageMetadataSchema.safeParse({ source: "github" }).success).toBe(false);
    expect(
      contextReviewerRunMessageMetadataSchema.safeParse({
        source: "bitbucket",
        contextTreeReviewer: true,
        contextReviewRunId: "run-1",
      }).success,
    ).toBe(false);
  });

  it("enforces review event and body limits without accepting a caller-provided head", () => {
    expect(contextReviewSubmitRequestSchema.parse({ event: "APPROVE", body: "Ready to merge." })).toEqual({
      event: "APPROVE",
      body: "Ready to merge.",
    });
    expect(
      contextReviewSubmitRequestSchema.safeParse({
        reviewedHead: "a".repeat(40),
        event: "APPROVE",
        body: "Ready.",
      }).success,
    ).toBe(false);
    expect(
      contextReviewSubmitRequestSchema.safeParse({
        event: "MERGE",
        body: "Ready.",
      }).success,
    ).toBe(false);
    expect(
      contextReviewSubmitRequestSchema.safeParse({
        event: "COMMENT",
        body: "x".repeat(CONTEXT_REVIEW_BODY_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      contextReviewSubmitRequestSchema.safeParse({
        event: "COMMENT",
        body: `Review text\n\n${CONTEXT_REVIEW_RUN_MARKER_PREFIX}another-run -->`,
      }).success,
    ).toBe(false);
  });
});
