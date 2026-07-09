import { CLI_BODY_ORIGIN_METADATA_KEY, CLI_BODY_ORIGINS } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { messages } from "../db/schema/messages.js";
import { createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("sendMessage escaped-newline guard", () => {
  const getApp = useTestApp();

  async function setupAgentChat(uid: string) {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `esc-s-${uid}` });
    const peer = await createTestAgent(app, { name: `esc-p-${uid}` });
    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    return { app, sender, peer, chat };
  }

  it("rejects agent-authored escaped multiline bodies before they are persisted", async () => {
    const { app, sender, peer, chat } = await setupAgentChat(crypto.randomUUID().slice(0, 6));

    await expect(
      sendMessage(app.db, chat.id, sender.agent.uuid, {
        source: "api",
        format: "markdown",
        content: "PR 提好了，是 draft：\\n\\nhttps://github.com/example/repo/pull/1\\n\\n验证通过",
        receiverNames: [peer.agent.name ?? ""],
      }),
    ).rejects.toThrow(/literal "\\n" escapes/i);

    const rows = await app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chat.id));
    expect(rows).toHaveLength(0);
  });

  it("rejects escaped multiline agent final text before the silent-send bypass can write history", async () => {
    const { app, sender, chat } = await setupAgentChat(crypto.randomUUID().slice(0, 6));

    await expect(
      sendMessage(app.db, chat.id, sender.agent.uuid, {
        source: "api",
        format: "markdown",
        content: "完成了：\\n\\n- commit: abc123\\n- branch: main",
        purpose: "agent-final-text",
      }),
    ).rejects.toThrow(/literal "\\n" escapes/i);

    const rows = await app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chat.id));
    expect(rows).toHaveLength(0);
  });

  it("accepts agent-authored markdown bodies that contain real newlines", async () => {
    const { app, sender, peer, chat } = await setupAgentChat(crypto.randomUUID().slice(0, 6));
    const body = "PR 提好了，是 draft：\n\nhttps://github.com/example/repo/pull/1\n\n验证通过";

    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "markdown",
      content: body,
      receiverNames: [peer.agent.name ?? ""],
    });

    expect(result.message.content).toBe(body);
  });

  it("preserves the CLI stdin/message-file escape hatch for intentional literal backslash-n text", async () => {
    const { app, sender, peer, chat } = await setupAgentChat(crypto.randomUUID().slice(0, 6));
    const body = "This message intentionally documents literal \\n\\n separators.";

    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "cli",
      format: "markdown",
      content: body,
      metadata: { [CLI_BODY_ORIGIN_METADATA_KEY]: CLI_BODY_ORIGINS.STDIN },
      receiverNames: [peer.agent.name ?? ""],
    });

    expect(result.message.content).toBe(body);
    expect(result.message.metadata).not.toHaveProperty(CLI_BODY_ORIGIN_METADATA_KEY);
  });

  it("leaves human-authored literal backslash-n prose alone", async () => {
    const app = getApp();
    const human = await createTestAgent(app, { type: "human", name: `esc-human-${crypto.randomUUID().slice(0, 6)}` });
    const peer = await createTestAgent(app, { name: `esc-human-peer-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, human.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    const body = "I literally want to discuss \\n\\n in this message.";

    const result = await sendMessage(app.db, chat.id, human.agent.uuid, {
      source: "web",
      format: "text",
      content: body,
      metadata: { mentions: [peer.agent.uuid] },
    });

    expect(result.message.content).toBe(body);
  });
});
