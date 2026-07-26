import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { suspendAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("sendMessage returns recipients", () => {
  const getApp = useTestApp();

  it("returns recipient inboxIds excluding sender", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `recip-a1-${crypto.randomUUID().slice(0, 6)}` });
    const { agent: a2 } = await createTestAgent(app, { name: `recip-a2-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, a1.uuid, {
      type: "group",
      participantIds: [a2.uuid],
    });

    // Agent↔agent direct seeds both as mention_only (migration 0029) so the
    // recipient is only included when explicitly @-mentioned. Pass the
    // mention so this stays a recipient-shape test rather than a mode test.
    const result = await sendMessage(app.db, chat.id, a1.uuid, {
      source: "api",
      format: "text",
      content: "hello",
      metadata: { mentions: [a2.uuid] },
    });

    expect(result.message).toBeDefined();
    expect(result.message.content).toBe("hello");
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0]).toBe(a2.inboxId);
  });

  it("returns empty recipients when no other participants", async () => {
    const app = getApp();
    const { agent: a1 } = await createTestAgent(app, { name: `recip-solo-${crypto.randomUUID().slice(0, 6)}` });

    const chat = await createChat(app.db, a1.uuid, {
      type: "group",
      participantIds: [],
    });

    const result = await sendMessage(
      app.db,
      chat.id,
      a1.uuid,
      {
        source: "api",
        format: "text",
        content: "talking to myself",
      },
      { allowRecipientlessSend: true },
    );

    expect(result.recipients).toHaveLength(0);
  });

  it("returns multiple recipients in group chat when both are explicitly mentioned", async () => {
    const app = getApp();
    // Under the explicit-only contract a group send wakes only the agents
    // declared in `metadata.mentions` (or `receiverNames`); declare both
    // peers to get both into the notify=true set.
    const uid = crypto.randomUUID().slice(0, 6);
    const name1 = `recip-g1-${uid}`;
    const name2 = `recip-g2-${uid}`;
    const name3 = `recip-g3-${uid}`;
    const { agent: a1 } = await createTestAgent(app, { name: name1, type: "human" });
    const { agent: a2 } = await createTestAgent(app, { name: name2 });
    const { agent: a3 } = await createTestAgent(app, { name: name3 });

    const chat = await createChat(app.db, a1.uuid, {
      type: "group",
      participantIds: [a2.uuid, a3.uuid],
    });

    const result = await sendMessage(app.db, chat.id, a1.uuid, {
      source: "api",
      format: "text",
      content: `group msg @${name2} @${name3}`,
      metadata: { mentions: [a2.uuid, a3.uuid] },
    });

    expect(result.recipients).toHaveLength(2);
    expect(result.recipients).toContain(a2.inboxId);
    expect(result.recipients).toContain(a3.inboxId);
    // Sender should not be in recipients
    expect(result.recipients).not.toContain(a1.inboxId);
  });

  it("rejects explicit routing to a suspended agent and writes no inbox entry", async () => {
    const app = getApp();
    const { agent: sender } = await createTestAgent(app, {
      name: `recip-suspend-src-${crypto.randomUUID().slice(0, 6)}`,
    });
    const { agent: suspended } = await createTestAgent(app, {
      name: `recip-suspend-target-${crypto.randomUUID().slice(0, 6)}`,
      displayName: "Suspended Target",
    });
    const chat = await createChat(app.db, sender.uuid, {
      type: "group",
      participantIds: [suspended.uuid],
    });
    await suspendAgent(app.db, suspended.uuid);

    await expect(
      sendMessage(app.db, chat.id, sender.uuid, {
        source: "api",
        format: "text",
        content: "wake up",
        metadata: { mentions: [suspended.uuid] },
      }),
    ).rejects.toThrow('Cannot route to "Suspended Target" because the agent is suspended');

    const rows = await app.db.select().from(inboxEntries).where(eq(inboxEntries.inboxId, suspended.inboxId));
    expect(rows).toHaveLength(0);
  });

  it("lets a trusted internal send drop an inactive mention while preserving active recipients", async () => {
    const app = getApp();
    const suffix = crypto.randomUUID().slice(0, 6);
    const { agent: sender } = await createTestAgent(app, { name: `trusted-src-${suffix}` });
    const { agent: active } = await createTestAgent(app, { name: `trusted-active-${suffix}` });
    const { agent: suspended } = await createTestAgent(app, { name: `trusted-suspended-${suffix}` });
    const chat = await createChat(app.db, sender.uuid, {
      type: "group",
      participantIds: [active.uuid, suspended.uuid],
    });
    await suspendAgent(app.db, suspended.uuid);

    const result = await sendMessage(
      app.db,
      chat.id,
      sender.uuid,
      {
        source: "github",
        format: "card",
        content: { type: "github_event" },
        metadata: { mentions: [active.uuid, suspended.uuid] },
      },
      { allowRecipientlessSend: true, dropInactiveMentionTargets: true },
    );

    expect(result.message.metadata.mentions).toEqual([active.uuid]);
    expect(result.recipients).toEqual([active.inboxId]);
    const suspendedRows = await app.db.select().from(inboxEntries).where(eq(inboxEntries.inboxId, suspended.inboxId));
    expect(suspendedRows).toHaveLength(0);
  });
});
