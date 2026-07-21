import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  addParticipantSchema,
  createKeyedTaskChatSchema,
  createTaskChatSchema,
  createWebTaskChatSchema,
  keyedTaskChatCreateResponseSchema,
  updateChatSchema,
} from "../schemas/chat.js";

const initialMessage = {
  content: "Start the task.",
  source: "web",
};

const reviewMetadata = {
  taskType: "context_tree_pr_review" as const,
  reviewPacketV1: {
    schemaVersion: 1 as const,
    repository: "acme/context-tree",
    pullRequest: 42,
    expectedHead: "a".repeat(40),
    baseRef: "main",
    sourceRef: "context/update",
    requesterGithubLogin: "alice",
    goal: "Record the approved decision",
    source: { label: "Decision", reference: "https://example.test/decision" },
    decisionSummary: "Use the assigned Reviewer",
    rationale: "Keep one authority path",
    targetPaths: ["system/reviewer.md"],
    repairScope: ["system/reviewer.md"],
    relevantContextRefs: [],
    unresolvedQuestions: [],
    verify: { status: "passed" as const, summary: "tree verify passed" },
    evidence: [],
  },
};

describe("chat write schemas", () => {
  it("requires at least one initial recipient when creating task chats", () => {
    expect(
      createTaskChatSchema.safeParse({
        mode: "task",
        initialMessage,
      }).success,
    ).toBe(false);

    expect(
      createWebTaskChatSchema.parse({
        mode: "task",
        initialRecipientNames: ["alice"],
        initialMessage,
      }),
    ).toMatchObject({
      mode: "task",
      initialRecipientNames: ["alice"],
      initialRecipientAgentIds: [],
    });

    expect(
      createTaskChatSchema.parse({
        mode: "task",
        initialRecipientAgentIds: ["agent-1"],
        initialMessage,
      }),
    ).toMatchObject({
      initialRecipientAgentIds: ["agent-1"],
      initialRecipientNames: [],
    });
  });

  it("accepts one campaign action contract and rejects it alongside the legacy field", () => {
    const base = {
      mode: "task" as const,
      initialRecipientAgentIds: ["agent-1"],
      initialMessage,
    };
    expect(
      createWebTaskChatSchema.parse({
        ...base,
        campaignAction: { campaign: "production-scan", repoSlug: "acme/api" },
      }).campaignAction,
    ).toEqual({ campaign: "production-scan", repoSlug: "acme/api" });
    expect(
      createWebTaskChatSchema.safeParse({
        ...base,
        campaignAction: { campaign: "production-scan", repoSlug: "acme/api" },
        scanFixRepoSlug: "acme/api",
      }).success,
    ).toBe(false);
  });

  it("keeps member keyed dispatch strict and server-derived", () => {
    const request = {
      mode: "keyed_task" as const,
      initialMessage: { format: "markdown" as const, content: "Review this Tree PR.", metadata: reviewMetadata },
    };
    expect(createKeyedTaskChatSchema.parse(request)).toEqual(request);
    expect(createKeyedTaskChatSchema.safeParse({ ...request, taskKey: "caller-key" }).success).toBe(false);
    expect(createKeyedTaskChatSchema.safeParse({ ...request, topic: "caller topic" }).success).toBe(false);
    expect(
      createKeyedTaskChatSchema.safeParse({
        ...request,
        initialMessage: { ...request.initialMessage, source: "cli" },
      }).success,
    ).toBe(false);
  });

  it("allows a reused keyed task to report the Chat's current null topic", () => {
    expect(
      keyedTaskChatCreateResponseSchema.parse({
        chatId: "chat-1",
        messageId: "message-1",
        topic: null,
        effectiveSenderId: "human-1",
        reviewerAgentUuid: "reviewer-1",
        outcome: "reused",
        managedReviewReceiptV1: {
          schemaVersion: 1,
          repository: "owner/context-tree",
          pullRequest: 749,
          expectedHead: "a".repeat(40),
        },
      }).topic,
    ).toBeNull();
    expect(
      keyedTaskChatCreateResponseSchema.safeParse({
        chatId: "chat-1",
        messageId: "message-1",
        topic: null,
        effectiveSenderId: "human-1",
        reviewerAgentUuid: "reviewer-1",
        outcome: "reused",
      }).success,
    ).toBe(false);
  });

  it("keeps the new receipt response additive for an older CLI response parser", () => {
    const legacyResponseSchema = z.object({
      chatId: z.string(),
      messageId: z.string(),
      topic: z.string().nullable(),
      effectiveSenderId: z.string(),
      reviewerAgentUuid: z.string(),
      outcome: z.enum(["created", "reused"]),
    });
    expect(
      legacyResponseSchema.parse({
        chatId: "chat-1",
        messageId: "message-1",
        topic: "Context Review · context-tree#749",
        effectiveSenderId: "human-1",
        reviewerAgentUuid: "reviewer-1",
        outcome: "created",
        managedReviewReceiptV1: {
          schemaVersion: 1,
          repository: "owner/context-tree",
          pullRequest: 749,
          expectedHead: "a".repeat(40),
        },
      }),
    ).toMatchObject({ chatId: "chat-1", outcome: "created" });
  });

  it("requires update chat requests to change at least one field", () => {
    expect(updateChatSchema.safeParse({}).success).toBe(false);
    expect(updateChatSchema.parse({ topic: "  Release prep  " })).toEqual({
      topic: "Release prep",
    });
    expect(updateChatSchema.parse({ description: null })).toEqual({
      description: null,
    });
  });

  it("requires exactly one participant target", () => {
    expect(addParticipantSchema.safeParse({}).success).toBe(false);
    expect(addParticipantSchema.safeParse({ agentId: "agent-1", agentName: "alice" }).success).toBe(false);
    expect(addParticipantSchema.parse({ agentId: "agent-1" })).toEqual({ agentId: "agent-1" });
    expect(addParticipantSchema.parse({ agentName: "alice" })).toEqual({ agentName: "alice" });
  });
});
