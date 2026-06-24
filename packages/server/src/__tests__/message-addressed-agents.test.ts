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

/**
 * `metadata.addressedAgentIds` carries the real routed non-human recipients so a
 * web surface (the chat offline notice) can tell who a turn awaits a reply from.
 * `mentions` only covers explicit @s / receiverNames — NOT the system
 * `addressedToAgentIds` routing the onboarding kickoff bootstrap uses — so the
 * bootstrap case below is the one a `mentions`-only read would miss.
 */
describe("preflightMessageSendIntent — addressedAgentIds", () => {
  it("persists the system addressedToAgentIds (onboarding bootstrap) even with no mentions", () => {
    const result = preflightMessageSendIntent({
      chatId: "c1",
      senderId: "human-1",
      senderType: "human",
      data: {
        format: "text",
        content: "Welcome — here are a few first tasks.",
        source: "api",
        metadata: { systemSender: "first_tree_onboarding" },
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
      data: { format: "text", content: "done", source: "api", metadata: {} },
      options: { addressedToAgentIds: ["human-1"] },
      participants: [HUMAN, AGENT],
    });
    expect(result.metadata.addressedAgentIds).toBeUndefined();
  });
});
