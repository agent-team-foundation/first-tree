import {
  FIRST_CHAT_ORIENTATION_CONTINUATION_METADATA_KEY,
  FIRST_CHAT_ORIENTATION_METADATA_KEY,
} from "@first-tree/shared";
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
  name: "assistant",
  displayName: "Assistant",
  status: "active",
  type: "agent",
};

function preflight(allowFirstChatOrientation = false) {
  return preflightMessageSendIntent({
    chatId: "chat-1",
    senderId: HUMAN.agentId,
    senderType: HUMAN.type,
    data: {
      format: "text",
      content: "Welcome.",
      source: "api",
      metadata: {
        [FIRST_CHAT_ORIENTATION_METADATA_KEY]: { version: 1 },
        [FIRST_CHAT_ORIENTATION_CONTINUATION_METADATA_KEY]: { version: 1, targetAgentId: AGENT.agentId },
        mentions: [AGENT.agentId],
      },
    },
    options: { allowFirstChatOrientation },
    participants: [HUMAN, AGENT],
  });
}

describe("first-chat Orientation metadata trust boundary", () => {
  it("strips a caller-authored marker from an ordinary message", () => {
    expect(preflight().metadata[FIRST_CHAT_ORIENTATION_METADATA_KEY]).toBeUndefined();
    expect(preflight().metadata[FIRST_CHAT_ORIENTATION_CONTINUATION_METADATA_KEY]).toBeUndefined();
  });

  it("preserves the marker for the trusted onboarding kickoff path", () => {
    expect(preflight(true).metadata[FIRST_CHAT_ORIENTATION_METADATA_KEY]).toEqual({ version: 1 });
    expect(preflight(true).metadata[FIRST_CHAT_ORIENTATION_CONTINUATION_METADATA_KEY]).toBeUndefined();
  });
});
