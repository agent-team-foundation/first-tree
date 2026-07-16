import { describe, expect, it } from "vitest";
import { preflightMessageSendIntent, type SendIntentParticipant } from "../services/message.js";

const HUMAN: SendIntentParticipant = {
  agentId: "human-1",
  name: "gandy",
  displayName: "Gandy",
  status: "active",
  type: "human",
};
const AGENT: SendIntentParticipant = {
  agentId: "agent-1",
  name: "asst",
  displayName: "Assistant",
  status: "active",
  type: "agent",
};
const AGENT_TWO: SendIntentParticipant = {
  agentId: "agent-2",
  name: "reviewer",
  displayName: "Reviewer",
  status: "active",
  type: "agent",
};

/**
 * `metadata.addressedAgentIds` carries server-owned notify-worthy non-human
 * recipients so a web surface (the chat offline notice) can tell who a turn
 * awaits a reply from. `mentions` only covers explicit @s / receiverNames —
 * NOT system `addressedToAgentIds` routing — so the system-routed case below is
 * the one a `mentions`-only read would miss.
 */
describe("preflightMessageSendIntent — addressedAgentIds", () => {
  it("persists system addressedToAgentIds even with no mentions", () => {
    const result = preflightMessageSendIntent({
      chatId: "c1",
      senderId: "human-1",
      senderType: "human",
      data: {
        format: "text",
        content: "PR opened.",
        source: "api",
        metadata: { systemSender: "github" },
      },
      options: { addressedToAgentIds: ["agent-1"], allowSystemSender: true },
      participants: [HUMAN, AGENT],
    });
    expect(result.metadata.addressedAgentIds).toEqual(["agent-1"]);
    expect(result.metadata.mentions).toBeUndefined();
  });

  it("persists an explicit @agent in both mentions and addressedAgentIds", () => {
    const result = preflightMessageSendIntent({
      chatId: "c1",
      senderId: "human-1",
      senderType: "human",
      data: { format: "text", content: "hi", source: "web", metadata: { mentions: ["agent-1"] } },
      participants: [HUMAN, AGENT],
    });
    expect(result.metadata.addressedAgentIds).toEqual(["agent-1"]);
    expect(result.metadata.mentions).toEqual(["agent-1"]);
  });

  it("does not record a human recipient as an addressed agent", () => {
    const result = preflightMessageSendIntent({
      chatId: "c1",
      senderId: "agent-1",
      senderType: "agent",
      data: {
        format: "text",
        content: "done",
        source: "api",
        metadata: { addressedAgentIds: ["agent-1"] },
      },
      options: { addressedToAgentIds: ["human-1"] },
      participants: [HUMAN, AGENT],
    });
    expect(result.metadata.addressedAgentIds).toBeUndefined();
  });

  it("strips caller-supplied addressedAgentIds when the server computes no awaited agents", () => {
    const result = preflightMessageSendIntent({
      chatId: "c1",
      senderId: "human-1",
      senderType: "human",
      data: {
        format: "text",
        content: "history note",
        source: "api",
        metadata: { addressedAgentIds: ["agent-1"] },
      },
      options: { allowRecipientlessSend: true },
      participants: [HUMAN, AGENT],
    });
    expect(result.metadata.addressedAgentIds).toBeUndefined();
  });

  it("does not record agent-final-text recipients as awaited agents", () => {
    const result = preflightMessageSendIntent({
      chatId: "c1",
      senderId: "agent-1",
      senderType: "agent",
      data: {
        format: "text",
        content: "final answer",
        source: "api",
        purpose: "agent-final-text",
        metadata: { mentions: ["agent-2"] },
      },
      participants: [HUMAN, AGENT, AGENT_TWO],
    });
    expect(result.metadata.mentions).toEqual(["agent-2"]);
    expect(result.metadata.addressedAgentIds).toBeUndefined();
  });
});
