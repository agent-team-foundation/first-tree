import { describe, expect, it } from "vitest";
import {
  addParticipantSchema,
  createTaskChatSchema,
  createWebTaskChatSchema,
  updateChatSchema,
} from "../schemas/chat.js";

const initialMessage = {
  content: "Start the task.",
  source: "web",
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
