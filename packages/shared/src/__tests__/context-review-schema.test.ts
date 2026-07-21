import { describe, expect, it } from "vitest";
import {
  CONTEXT_REVIEW_BODY_MAX_BYTES,
  contextReviewAuthorityResponseSchema,
  contextReviewErrorCodeSchema,
  contextReviewerRunMessageMetadataSchema,
  contextReviewSubmitRequestSchema,
  contextReviewSubmitResponseSchema,
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
        contextReviewHeadSha: "a".repeat(40),
        contextReviewOrganizationId: "org-1",
        contextReviewReviewerAgentUuid: "reviewer-1",
        contextReviewReviewerManagerHumanAgentId: "human-1",
        contextReviewInstallationId: 42,
        contextReviewReviewerClientId: "client-1",
        contextReviewRuntimeSessionBoundAt: "2026-07-21T00:00:00.000Z",
        contextReviewSubmission: { state: "pending" },
        mentions: ["reviewer-1"],
      }).success,
    ).toBe(true);
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
        contextReviewHeadSha: "a".repeat(40),
        contextReviewOrganizationId: "org-1",
        contextReviewReviewerAgentUuid: "reviewer-1",
        contextReviewReviewerManagerHumanAgentId: "human-1",
        contextReviewSubmission,
      }).success,
    ).toBe(true);
  });

  it("rejects incomplete or non-GitHub run envelopes", () => {
    expect(contextReviewerRunMessageMetadataSchema.safeParse({ source: "github" }).success).toBe(false);
    expect(
      contextReviewerRunMessageMetadataSchema.safeParse({
        source: "gitlab",
        contextTreeReviewer: true,
        contextReviewRunId: "run-1",
      }).success,
    ).toBe(false);
  });

  it("accepts only durably claimed historical headless App runs", () => {
    const base = {
      source: "github",
      contextTreeReviewer: true,
      contextReviewRunId: "run-1",
      contextReviewRepository: "acme/context-tree",
      contextReviewPrNumber: 42,
      contextReviewOrganizationId: "org-1",
      contextReviewReviewerAgentUuid: "reviewer-1",
      contextReviewReviewerManagerHumanAgentId: "human-1",
    } as const;
    expect(
      contextReviewerRunMessageMetadataSchema.safeParse({
        ...base,
        contextReviewSubmission: {
          state: "unknown",
          payloadHash: "legacy-hash",
          attemptId: "attempt-1",
          reviewedHead: "a".repeat(40),
          event: "COMMENT",
          failedAt: "2026-07-21T00:00:00.000Z",
          reviewerClientId: "client-1",
        },
      }).success,
    ).toBe(true);
    expect(
      contextReviewerRunMessageMetadataSchema.safeParse({
        ...base,
        contextReviewSubmission: { state: "pending" },
      }).success,
    ).toBe(false);
  });

  it("accepts the server's superseded-run error code", () => {
    expect(contextReviewErrorCodeSchema.parse("CONTEXT_REVIEW_RUN_SUPERSEDED")).toBe("CONTEXT_REVIEW_RUN_SUPERSEDED");
  });

  it("pins authority identity and publication disposition in shared responses", () => {
    expect(
      contextReviewAuthorityResponseSchema.parse({
        authorized: true,
        repository: "acme/context-tree",
        prNumber: 42,
        reviewedHead: "A".repeat(40),
        state: "open",
        draft: false,
        baseRef: "main",
        headRef: "context-update",
        headRepository: "acme/context-tree",
        sameRepository: true,
        installationId: 7,
        reviewerClientId: "client-1",
        runtimeSessionBoundAt: "2026-07-21T00:00:00.000Z",
      }).reviewedHead,
    ).toBe("a".repeat(40));
    expect(
      contextReviewSubmitResponseSchema.safeParse({
        action: "APPROVE",
        reviewedHead: "a".repeat(40),
        reviewId: 42,
        reviewUrl: "https://github.com/acme/context-tree/pull/42#pullrequestreview-42",
        appActor: "first-tree[bot]",
        publicationDisposition: "existing",
      }).success,
    ).toBe(true);
    expect(
      contextReviewSubmitResponseSchema.safeParse({
        action: "APPROVE",
        reviewedHead: "a".repeat(40),
        reviewId: 42,
        reviewUrl: "https://github.com/acme/context-tree/pull/42#pullrequestreview-42",
        appActor: "first-tree[bot]",
      }).success,
    ).toBe(false);
  });

  it("normalizes exact heads and enforces review event and body limits", () => {
    expect(
      contextReviewSubmitRequestSchema.parse({
        reviewedHead: "A".repeat(40),
        event: "APPROVE",
        body: "Ready to merge.",
      }).reviewedHead,
    ).toBe("a".repeat(40));
    expect(
      contextReviewSubmitRequestSchema.safeParse({
        reviewedHead: "a".repeat(40),
        event: "MERGE",
        body: "Ready.",
      }).success,
    ).toBe(false);
    expect(
      contextReviewSubmitRequestSchema.safeParse({
        reviewedHead: "a".repeat(40),
        event: "COMMENT",
        body: "x".repeat(CONTEXT_REVIEW_BODY_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      contextReviewSubmitRequestSchema.safeParse({
        reviewedHead: "a".repeat(40),
        event: "COMMENT",
        body: "Ready.",
        appToken: "caller-selected",
      }).success,
    ).toBe(false);
  });
});
