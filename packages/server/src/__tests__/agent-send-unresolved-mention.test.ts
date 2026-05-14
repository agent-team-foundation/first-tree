import { describe, expect, it } from "vitest";
import { createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * v1.7 follow-up to §四 改造 1 — server-side guard for `@<non-speaker>` in
 * agent-initiated sends.
 *
 * Symptom this closes (PR #393 dogfood): agent typed `@tester` into a chat
 * where tester wasn't a speaker. `extractMentions` silently returned [],
 * `enforceGroupMention` didn't trip on direct chats, and the message landed
 * with `mentions=[]` — tester never woke. The agent then lied back to the
 * human ("已经通过私信发送了").
 *
 * New invariant: on the agent path (`enforceGroupMention: true`), any raw
 * `@<token>` in content that doesn't resolve to a chat speaker fails the
 * write with 400 + a hint pointing at `--direct <name>`. Both `direct` and
 * `group` chat shapes are guarded so the dogfood gap is sealed.
 *
 * Bypassed by `purpose: "agent-final-text"` (handler forwards, not user
 * routing — same as enforceGroupMention).
 */

describe("sendMessage — unresolved-@-token guard (v1 §四 改造 1 follow-up)", () => {
  const getApp = useTestApp();

  it("rejects @<non-speaker> in a DIRECT chat (the dogfood case)", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { type: "autonomous_agent" });
    const peer = await createTestAgent(app, { type: "human" });
    const outsider = await createTestAgent(app, { name: `outsider-${crypto.randomUUID().slice(0, 6)}` });
    if (!outsider.agent.name) throw new Error("outsider name missing");

    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "direct",
      participantIds: [peer.agent.uuid],
    });

    await expect(
      sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { format: "text", content: `@${outsider.agent.name} 你好` },
        { enforceGroupMention: true },
      ),
    ).rejects.toThrow(new RegExp(`Cannot @-mention "${outsider.agent.name}"`));
  });

  it("hint recommends `--direct <name>` (not `add-participant`) for the typed token", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { type: "autonomous_agent" });
    const peer = await createTestAgent(app, { type: "human" });
    const outsider = await createTestAgent(app, { name: `hinted-${crypto.randomUUID().slice(0, 6)}` });
    if (!outsider.agent.name) throw new Error("outsider name missing");

    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "direct",
      participantIds: [peer.agent.uuid],
    });

    try {
      await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { format: "text", content: `@${outsider.agent.name} ping` },
        { enforceGroupMention: true },
      );
      throw new Error("expected sendMessage to reject");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain(`--direct ${outsider.agent.name}`);
      expect(message).not.toMatch(/add-participant/i);
    }
  });

  it("rejects @<non-speaker> in a GROUP chat (defence-in-depth on top of enforceGroupMention)", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { type: "autonomous_agent" });
    const inGroupPeer = await createTestAgent(app, { type: "autonomous_agent" });
    const outsider = await createTestAgent(app, { name: `gout-${crypto.randomUUID().slice(0, 6)}` });
    if (!outsider.agent.name || !inGroupPeer.agent.name) throw new Error("name missing");

    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [inGroupPeer.agent.uuid],
    });

    // Includes a valid @ for the in-group peer + an invalid @ for the
    // outsider. enforceGroupMention would have accepted this (valid mention
    // resolved), so the new guard is what actually catches it.
    await expect(
      sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        {
          format: "text",
          content: `@${inGroupPeer.agent.name} please ping @${outsider.agent.name}`,
        },
        { enforceGroupMention: true },
      ),
    ).rejects.toThrow(new RegExp(`Cannot @-mention "${outsider.agent.name}"`));
  });

  it("accepts content with ONLY resolved @-tokens (regression)", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { type: "autonomous_agent" });
    const inGroupPeer = await createTestAgent(app, { type: "autonomous_agent" });
    if (!inGroupPeer.agent.name) throw new Error("peer name missing");

    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [inGroupPeer.agent.uuid],
    });

    const result = await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      { format: "text", content: `@${inGroupPeer.agent.name} status?` },
      { enforceGroupMention: true },
    );
    expect(result.message).toBeDefined();
  });

  it("ignores @<token> inside code fences (no false positive)", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { type: "autonomous_agent" });
    const peer = await createTestAgent(app, { type: "human" });
    if (!peer.agent.name) throw new Error("peer name missing");

    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "direct",
      participantIds: [peer.agent.uuid],
    });

    // @nonexistent sits inside a fenced code block — extractMentions /
    // scanMentionTokens already strip these. The guard must not trip.
    const result = await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      { format: "text", content: "Example:\n```\nrun `@nonexistent` to ...\n```" },
      { enforceGroupMention: true },
    );
    expect(result.message).toBeDefined();
  });

  it("bypassed by purpose='agent-final-text' (handler forward is not routing)", async () => {
    // result-sink / AskUserQuestion forwards in a group chat may carry
    // raw `@<name>` text that doesn't resolve (e.g. an agent's reply
    // narrating a teammate by name). The final-text bypass channel must
    // still ferry the message through to history without 400-ing.
    const app = getApp();
    const sender = await createTestAgent(app, { type: "autonomous_agent" });
    const inGroupPeer = await createTestAgent(app, { type: "autonomous_agent" });
    const outsider = await createTestAgent(app, { name: `bp-${crypto.randomUUID().slice(0, 6)}` });
    if (!outsider.agent.name) throw new Error("outsider name missing");

    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [inGroupPeer.agent.uuid],
    });

    const result = await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      {
        format: "text",
        content: `Replying about @${outsider.agent.name}'s question — they aren't in this chat.`,
        purpose: "agent-final-text",
      },
      { enforceGroupMention: true },
    );
    expect(result.message).toBeDefined();
    // And per the bypass channel contract, no one is woken.
    expect(result.recipients).toEqual([]);
  });

  it("does NOT enforce when the flag is off (adapters / webhooks)", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { type: "autonomous_agent" });
    const peer = await createTestAgent(app, { type: "human" });
    const outsider = await createTestAgent(app, { name: `off-${crypto.randomUUID().slice(0, 6)}` });
    if (!outsider.agent.name) throw new Error("outsider name missing");

    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "direct",
      participantIds: [peer.agent.uuid],
    });

    // No enforceGroupMention — adapter bridge / webhook path. Guard is
    // intentionally agent-only; non-agent paths preserve "@-token-as-text"
    // semantics.
    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      format: "text",
      content: `Mentioning @${outsider.agent.name} in a notification`,
    });
    expect(result.message).toBeDefined();
  });
});
