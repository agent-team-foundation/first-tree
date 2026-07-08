import { describe, expect, it } from "vitest";
import { NotFoundError } from "../errors.js";
import { createChat } from "../services/chat.js";
import {
  maybeUnwrapDoubleEncoded,
  preflightMessageSendIntent,
  type SendIntentParticipant,
  sendMessage,
} from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("message service edge coverage", () => {
  const getApp = useTestApp();

  const sender = {
    agentId: "sender-1",
    name: "sender",
    displayName: "Sender",
    status: "active",
    type: "agent",
  } satisfies SendIntentParticipant;

  it("rejects inactive explicit and system-routed recipients with recovery copy", () => {
    const suspended = {
      agentId: "target-suspended",
      name: "target",
      displayName: "Suspended Target",
      status: "suspended",
      type: "agent",
    } satisfies SendIntentParticipant;
    expect(() =>
      preflightMessageSendIntent({
        chatId: "chat-1",
        senderId: sender.agentId,
        senderType: "agent",
        data: {
          source: "cli",
          format: "text",
          content: "hello",
          metadata: { mentions: [suspended.agentId] },
        },
        participants: [sender, suspended],
      }),
    ).toThrow(/Reactivate it before sending/);

    const deleted = {
      ...suspended,
      agentId: "target-deleted",
      displayName: "",
      status: "deleted",
    } satisfies SendIntentParticipant;
    expect(() =>
      preflightMessageSendIntent({
        chatId: "chat-1",
        senderId: sender.agentId,
        senderType: "agent",
        data: { source: "cli", format: "text", content: "hello" },
        options: { addressedToAgentIds: [deleted.agentId] },
        participants: [sender, deleted],
      }),
    ).toThrow(/Deleted agents cannot receive new messages/);
  });

  it("returns null when a double-encoded string candidate is not valid JSON", () => {
    expect(maybeUnwrapDoubleEncoded('"bad\\n\\x"')).toBeNull();
  });

  it("rejects sends from an unknown sender before preflight routing", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "agent" });
    const peer = await createTestAgent(app, { type: "agent" });
    const chat = await createChat(app.db, owner.agent.uuid, { type: "group", participantIds: [peer.agent.uuid] });

    await expect(
      sendMessage(app.db, chat.id, "missing-sender", {
        source: "cli",
        format: "text",
        content: "hello",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
