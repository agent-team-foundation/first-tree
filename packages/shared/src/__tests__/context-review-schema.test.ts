import { describe, expect, it } from "vitest";
import {
  CONTEXT_REVIEW_PACKET_MAX_BYTES,
  CONTEXT_REVIEW_TASK_METADATA_MAX_DEPTH,
  contextReviewManagedMessageMetadataSchema,
  contextReviewTaskCreateMetadataSchema,
  contextReviewTaskMetadataSchema,
  reviewPacketV1Schema,
} from "../schemas/context-review.js";

function packet() {
  return {
    schemaVersion: 1,
    repository: "acme/context",
    pullRequest: 42,
    expectedHead: "A".repeat(40),
    baseRef: "main",
    sourceRef: "feature/context",
    requesterGithubLogin: "alice",
    goal: "Record the current decision",
    source: { label: "Design", reference: "https://example.test/design" },
    decisionSummary: "Use one Reviewer Agent",
    rationale: "Keep the workflow small",
    targetPaths: ["system/reviewer.md"],
    repairScope: ["system/reviewer.md"],
    relevantContextRefs: [],
    unresolvedQuestions: [],
    verify: { status: "passed", summary: "tree verify passed" },
    evidence: [],
  };
}

describe("Context Review task metadata", () => {
  it("normalizes the expected head and accepts a valid packet", () => {
    const parsed = reviewPacketV1Schema.parse(packet());
    expect(parsed.expectedHead).toBe("a".repeat(40));
  });

  it("rejects path traversal and unknown packet fields", () => {
    expect(() => reviewPacketV1Schema.parse({ ...packet(), repairScope: ["../NODE.md"] })).toThrow();
    expect(() => reviewPacketV1Schema.parse({ ...packet(), unexpected: true })).toThrow();
  });

  it("rejects serialized payloads above the shared limit", () => {
    const result = contextReviewTaskMetadataSchema.safeParse({
      taskType: "context_tree_pr_review",
      reviewPacketV1: { ...packet(), rationale: "x".repeat(CONTEXT_REVIEW_PACKET_MAX_BYTES) },
    });
    expect(result.success).toBe(false);
  });

  it("rechecks the serialized limit after packet defaults are materialized", () => {
    const sparsePacket = { ...packet(), rationale: "x" };
    delete (sparsePacket as Partial<typeof sparsePacket>).relevantContextRefs;
    delete (sparsePacket as Partial<typeof sparsePacket>).unresolvedQuestions;
    delete (sparsePacket as Partial<typeof sparsePacket>).evidence;
    const metadata = { taskType: "context_tree_pr_review", reviewPacketV1: sparsePacket };
    const initialBytes = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
    sparsePacket.rationale = "x".repeat(CONTEXT_REVIEW_PACKET_MAX_BYTES - initialBytes + 1);
    expect(new TextEncoder().encode(JSON.stringify(metadata)).byteLength).toBe(CONTEXT_REVIEW_PACKET_MAX_BYTES);

    expect(contextReviewTaskMetadataSchema.safeParse(metadata).success).toBe(false);
  });

  it("rejects structurally oversized metadata without throwing", () => {
    const metadata = {
      taskType: "context_tree_pr_review",
      reviewPacketV1: { ...packet(), evidence: Array.from({ length: 9_000 }, () => null) },
    };
    expect(() => contextReviewTaskMetadataSchema.safeParse(metadata)).not.toThrow();
    expect(contextReviewTaskMetadataSchema.safeParse(metadata).success).toBe(false);
  });

  it("rejects deeply nested untrusted metadata without throwing", () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < CONTEXT_REVIEW_TASK_METADATA_MAX_DEPTH + 10; i += 1) nested = [nested];
    expect(() =>
      contextReviewTaskMetadataSchema.safeParse({
        taskType: "context_tree_pr_review",
        reviewPacketV1: nested,
      }),
    ).not.toThrow();
    expect(
      contextReviewTaskMetadataSchema.safeParse({
        taskType: "context_tree_pr_review",
        reviewPacketV1: nested,
      }).success,
    ).toBe(false);
  });

  it("admits only verified deterministic Write packets for dispatch", () => {
    const valid = { taskType: "context_tree_pr_review", reviewPacketV1: packet() };
    expect(contextReviewTaskCreateMetadataSchema.safeParse(valid).success).toBe(true);
    expect(
      contextReviewTaskCreateMetadataSchema.safeParse({
        ...valid,
        reviewPacketV1: { ...packet(), verify: { status: "failed", summary: "verify failed" } },
      }).success,
    ).toBe(false);
    expect(
      contextReviewTaskCreateMetadataSchema.safeParse({
        ...valid,
        reviewPacketV1: { ...packet(), targetPaths: ["z.md", "a.md"], repairScope: ["a.md", "z.md"] },
      }).success,
    ).toBe(false);
    expect(
      contextReviewTaskCreateMetadataSchema.safeParse({
        ...valid,
        reviewPacketV1: { ...packet(), targetPaths: ["outside.md"] },
      }).success,
    ).toBe(false);
  });
});

describe("managed Context Review event metadata", () => {
  const metadata = {
    source: "github",
    systemSender: "github",
    contextReviewManagedEventV1: {
      schemaVersion: 1,
      eventType: "issue_comment",
      action: "edited",
      triggerEvent: "issue_comment.edited",
      repository: "acme/context",
      pullRequest: 42,
      senderLogin: "alice",
      commentId: "5015744884",
      commentAuthorLogin: "alice",
      commentUrl: "https://github.com/acme/context/pull/42#issuecomment-5015744884",
    },
    addressedAgentIds: ["reviewer-id"],
  };

  it("accepts the complete server-authored envelope and passthrough delivery metadata", () => {
    expect(contextReviewManagedMessageMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(
      contextReviewManagedMessageMetadataSchema.safeParse({
        ...metadata,
        contextReviewManagedEventV1: {
          ...metadata.contextReviewManagedEventV1,
          eventType: "pull_request",
          action: "closed",
          triggerEvent: "pull_request.closed",
          terminalState: "merged",
        },
        contextReviewManagedLifecycleV1: { schemaVersion: 1, state: "merged" },
      }).success,
    ).toBe(true);
  });

  it("rejects incomplete, malformed, or non-GitHub envelopes", () => {
    expect(contextReviewManagedMessageMetadataSchema.safeParse({ systemSender: "github" }).success).toBe(false);
    expect(
      contextReviewManagedMessageMetadataSchema.safeParse({
        ...metadata,
        contextReviewManagedEventV1: { ...metadata.contextReviewManagedEventV1, commentId: "not-numeric" },
      }).success,
    ).toBe(false);
    expect(
      contextReviewManagedMessageMetadataSchema.safeParse({
        ...metadata,
        contextReviewManagedEventV1: { ...metadata.contextReviewManagedEventV1, commentId: "0" },
      }).success,
    ).toBe(false);
    expect(contextReviewManagedMessageMetadataSchema.safeParse({ ...metadata, source: "api" }).success).toBe(false);
    expect(
      contextReviewManagedMessageMetadataSchema.safeParse({
        ...metadata,
        contextReviewManagedLifecycleV1: { schemaVersion: 1, state: "draft" },
      }).success,
    ).toBe(false);
    expect(
      contextReviewManagedMessageMetadataSchema.safeParse({
        ...metadata,
        contextReviewManagedEventV1: {
          ...metadata.contextReviewManagedEventV1,
          terminalState: "open",
        },
      }).success,
    ).toBe(false);
  });
});
