import { describe, expect, it } from "vitest";
import { createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * The web UI re-attributes a message row to a synthetic "GitHub" sender
 * when `metadata.systemSender === "github"` (chat-view + the conjunctive
 * trust gate in `github-event-card.tsx`). Because `sendMessageSchema`
 * accepts arbitrary metadata at the HTTP boundary, a malicious agent
 * could otherwise POST a regular text message with that key set and the
 * UI would render it as if it came from GitHub. The service layer
 * unconditionally strips the key unless the caller opts in via
 * `allowSystemSender: true` — only `github-delivery.deliverGithubEvent`
 * does. These tests pin both halves: the strip on the default path and
 * the persistence when the trusted opt-in is set.
 */
describe("sendMessage strips metadata.systemSender from untrusted callers", () => {
  const getApp = useTestApp();

  it("drops metadata.systemSender on a default (non-opted-in) send", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { agent: human } = await createTestAgent(app, { name: `strip-h-${uid}`, type: "human" });
    const { agent: peer } = await createTestAgent(app, { name: `strip-p-${uid}` });
    const chat = await createChat(app.db, human.uuid, { type: "group", participantIds: [peer.uuid] });

    const { message } = await sendMessage(app.db, chat.id, human.uuid, {
      source: "api",
      format: "text",
      content: "hello",
      // A malicious caller (web / agent SDK POST) might try to smuggle
      // this in alongside their normal text.
      metadata: { systemSender: "github", mentions: [peer.uuid] },
    });

    const stored = message.metadata as Record<string, unknown>;
    expect(stored.systemSender).toBeUndefined();
    // Other metadata (mentions) must survive — the strip is targeted.
    expect(stored.mentions).toEqual([peer.uuid]);
  });

  it("preserves metadata.systemSender when the trusted-internal opt-in is set", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { agent: human } = await createTestAgent(app, { name: `strip-h2-${uid}`, type: "human" });
    const { agent: peer } = await createTestAgent(app, { name: `strip-p2-${uid}` });
    const chat = await createChat(app.db, human.uuid, { type: "group", participantIds: [peer.uuid] });

    const { message } = await sendMessage(
      app.db,
      chat.id,
      human.uuid,
      {
        source: "github",
        format: "text",
        content: "hello",
        metadata: { systemSender: "github", mentions: [peer.uuid] },
      },
      { allowSystemSender: true },
    );

    const stored = message.metadata as Record<string, unknown>;
    expect(stored.systemSender).toBe("github");
  });
});
