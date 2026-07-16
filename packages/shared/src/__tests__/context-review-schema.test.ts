import { describe, expect, it } from "vitest";
import {
  CONTEXT_REVIEW_PACKET_MAX_BYTES,
  contextReviewTaskMetadataSchema,
  reviewPacketV1Schema,
} from "../schemas/context-review.js";

function validPacket() {
  return {
    schemaVersion: 1 as const,
    repository: "acme/context-tree",
    pullRequest: 42,
    expectedHead: "A".repeat(40),
    baseRef: "main",
    sourceRef: "context/member-update",
    requesterGithubLogin: "octocat",
    goal: "Record the approved member routing decision.",
    source: {
      label: "Design decision",
      reference: "https://example.test/decisions/42",
      revision: "v3",
    },
    decisionSummary: "Route billing questions to the finance domain owner.",
    rationale: "The finance owner owns the durable policy and escalation path.",
    targetPaths: ["operating-model/routing.md"],
    repairScope: ["operating-model/routing.md"],
    relevantContextRefs: ["operating-model/NODE.md"],
    unresolvedQuestions: [],
    verify: { status: "passed" as const, summary: "Context Tree verification passed." },
    evidence: [
      {
        kind: "reference" as const,
        label: "Approved source",
        reference: "https://example.test/decisions/42",
        revision: "v3",
      },
    ],
  };
}

describe("Context Review schemas", () => {
  it("normalizes a versioned Review Packet head and supplies collection defaults", () => {
    const packet = validPacket();
    const parsed = reviewPacketV1Schema.parse({
      ...packet,
      targetPaths: undefined,
      relevantContextRefs: undefined,
      unresolvedQuestions: undefined,
      evidence: undefined,
    });

    expect(parsed.expectedHead).toBe("a".repeat(40));
    expect(parsed.targetPaths).toEqual([]);
    expect(parsed.relevantContextRefs).toEqual([]);
    expect(parsed.unresolvedQuestions).toEqual([]);
    expect(parsed.evidence).toEqual([]);
  });

  it("accepts the generic Context Review task envelope", () => {
    expect(
      contextReviewTaskMetadataSchema.parse({
        taskType: "context_tree_pr_review",
        reviewPacketV1: validPacket(),
      }),
    ).toMatchObject({
      taskType: "context_tree_pr_review",
      reviewPacketV1: { expectedHead: "a".repeat(40), pullRequest: 42 },
    });
  });

  it("rejects aggregate decoded string payloads above the V1 boundary", () => {
    expect(() =>
      contextReviewTaskMetadataSchema.parse({
        taskType: "context_tree_pr_review",
        reviewPacketV1: { ...validPacket(), goal: "x".repeat(CONTEXT_REVIEW_PACKET_MAX_BYTES) },
      }),
    ).toThrow(`${CONTEXT_REVIEW_PACKET_MAX_BYTES} decoded UTF-8 bytes`);

    expect(() =>
      contextReviewTaskMetadataSchema.parse({
        taskType: "context_tree_pr_review",
        reviewPacketV1: {
          ...validPacket(),
          source: {
            ...validPacket().source,
            ignoredClientString: "界".repeat(CONTEXT_REVIEW_PACKET_MAX_BYTES),
          },
        },
      }),
    ).toThrow(`${CONTEXT_REVIEW_PACKET_MAX_BYTES} decoded UTF-8 bytes`);
  });

  it("rejects an unversioned or non-GitHub-shaped task packet", () => {
    expect(() => reviewPacketV1Schema.parse({ ...validPacket(), schemaVersion: 2 })).toThrow();
    expect(() => reviewPacketV1Schema.parse({ ...validPacket(), repository: "missing-owner" })).toThrow("owner/name");
    expect(() => reviewPacketV1Schema.parse({ ...validPacket(), repairScope: ["../NODE.md"] })).toThrow(
      "repository-relative",
    );
  });
});
