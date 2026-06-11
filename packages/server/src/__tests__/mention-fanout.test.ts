import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { addParticipant, createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Server-authoritative routing + fan-out filtering. Post-retire of
 * content extraction, sendMessage's contract is:
 *
 *   - Mention set = `metadata.mentions` ∪ `receiverNames`-resolved
 *     (the server NEVER parses `@<name>` tokens out of content; clients
 *     resolve mentions and pass uuids on the wire).
 *   - `addressedToAgentIds` widens notify=true within the non-silenced
 *     fan-out (system-routed override; github-delivery is the only
 *     production caller).
 *   - notify=true only for agentIds in the mention set ∪ addressed set;
 *     all other speakers get notify=false context rows.
 *
 * These tests exercise the sendMessage service directly so behaviour is
 * pinned regardless of which HTTP path (web / agent) produced
 * the call.
 */
describe("server routing + fan-out filter (explicit mentions only)", () => {
  const getApp = useTestApp();

  /**
   * Only counts rows that will *wake the recipient's session* (notify=true).
   * Silent context rows (notify=false) are intentionally excluded so
   * "is this participant in the active fan-out?" still means "would
   * this agent's session be woken?".
   */
  async function inboxEntriesFor(app: ReturnType<typeof getApp>, chatId: string, agentUuid: string) {
    const [row] = await app.db
      .select({ inboxId: agents.inboxId })
      .from(agents)
      .where(eq(agents.uuid, agentUuid))
      .limit(1);
    if (!row) return [];
    return app.db
      .select({ messageId: inboxEntries.messageId })
      .from(inboxEntries)
      .where(
        and(eq(inboxEntries.inboxId, row.inboxId), eq(inboxEntries.chatId, chatId), eq(inboxEntries.notify, true)),
      );
  }

  async function setParticipantMode(
    app: ReturnType<typeof getApp>,
    chatId: string,
    agentUuid: string,
    mode: "full" | "mention_only",
  ) {
    await app.db
      .update(chatMembership)
      .set({ mode })
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, agentUuid)));
  }

  /**
   * Build a 3-agent group chat: sender (full), observer-A (mention_only),
   * observer-B (mention_only). The sender always writes; the two observers
   * are what we assert on.
   */
  async function setupGroup(app: ReturnType<typeof getApp>, uid: string) {
    const sender = await createTestAgent(app, { name: `mf-sender-${uid}` });
    const { agent: obsA } = await createTestAgent(app, { name: `mf-obsA-${uid}` });
    const { agent: obsB } = await createTestAgent(app, { name: `mf-obsB-${uid}` });

    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [obsA.uuid, obsB.uuid],
    });
    await setParticipantMode(app, chat.id, sender.agent.uuid, "full");
    await setParticipantMode(app, chat.id, obsA.uuid, "mention_only");
    await setParticipantMode(app, chat.id, obsB.uuid, "mention_only");

    return { sender, obsA, obsB, chat };
  }

  it("metadata.mentions wakes exactly the named recipients (notify=true) and nobody else", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, obsA, obsB, chat } = await setupGroup(app, uid);

    await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "text",
      content: "please review",
      metadata: { mentions: [obsA.uuid] },
    });

    const obsAEntries = await inboxEntriesFor(app, chat.id, obsA.uuid);
    const obsBEntries = await inboxEntriesFor(app, chat.id, obsB.uuid);
    expect(obsAEntries).toHaveLength(1);
    expect(obsBEntries).toHaveLength(0);
  });

  it("a narrative `@<peer>` in content alone does NOT wake the peer (server does not parse content)", async () => {
    // Regression guard for the explicit-only contract.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, obsA, chat } = await setupGroup(app, uid);

    await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      {
        source: "api",
        format: "text",
        content: `@mf-obsA-${uid} please review`,
      },
      { allowRecipientlessSend: true },
    );

    expect(await inboxEntriesFor(app, chat.id, obsA.uuid)).toHaveLength(0);
  });

  it("a 3+ speaker chat without explicit mentions wakes no one", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, obsA, obsB, chat } = await setupGroup(app, uid);
    await setParticipantMode(app, chat.id, obsA.uuid, "full");

    await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      {
        source: "api",
        format: "text",
        content: "nothing specific, team",
      },
      { allowRecipientlessSend: true },
    );

    expect(await inboxEntriesFor(app, chat.id, obsA.uuid)).toHaveLength(0);
    expect(await inboxEntriesFor(app, chat.id, obsB.uuid)).toHaveLength(0);
  });

  it("explicit metadata.mentions is the routing truth — `@<peer>` in content is just narrative", async () => {
    // Caller passes `mentions: [obsA]` AND text mentions obsB. The
    // server only honours `metadata.mentions` — narrative `@<peer>` in
    // content never widens the wake set under the explicit-only contract.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, obsA, obsB, chat } = await setupGroup(app, uid);

    await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "text",
      content: `heads up @mf-obsB-${uid}`,
      metadata: { mentions: [obsA.uuid] },
    });

    expect(await inboxEntriesFor(app, chat.id, obsA.uuid)).toHaveLength(1);
    expect(await inboxEntriesFor(app, chat.id, obsB.uuid)).toHaveLength(0);
  });

  it("`receiverNames` resolves recipient names server-side and wakes them", async () => {
    // CLI / programmatic callers that know the recipient by name (but not
    // uuid) pass `receiverNames`; server resolves against the chat's
    // speaker list and adds the resolved uuids to `mentions`. Like
    // `metadata.mentions`, this is explicit routing — `@<peer>` in
    // content alone is still ignored.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, obsA, obsB, chat } = await setupGroup(app, uid);
    if (!obsA.name) throw new Error("obsA name missing");

    await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "text",
      // Narrative reference to obsB in content — must NOT wake obsB
      // because only obsA is in `receiverNames`.
      content: `(cc'd @mf-obsB-${uid} for context) please review`,
      receiverNames: [obsA.name],
    });

    expect(await inboxEntriesFor(app, chat.id, obsA.uuid)).toHaveLength(1);
    expect(await inboxEntriesFor(app, chat.id, obsB.uuid)).toHaveLength(0);
  });

  it("`receiverNames` rejects an unknown name with a chat-invite hint", async () => {
    // Pin the resolve-or-throw behaviour: unknown names are a 400, not
    // a silent drop. (Content extraction's old `@<unknown>` drop-and-
    // warn behaviour is gone; explicit declarations are strict.)
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, chat } = await setupGroup(app, uid);

    await expect(
      sendMessage(app.db, chat.id, sender.agent.uuid, {
        source: "api",
        format: "text",
        content: "ping",
        receiverNames: ["nobody-by-that-name"],
      }),
    ).rejects.toThrow(/chat invite/i);
  });

  it("persists the resolved mentions into message.metadata for downstream reads", async () => {
    // Pin that the merged mention list is stored on the message row — not
    // only used as a transient fan-out signal — so reply-to routing /
    // audit / UI highlighting can all read the same source of truth.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, obsA, chat } = await setupGroup(app, uid);

    const { message } = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "text",
      content: "hi",
      metadata: { mentions: [obsA.uuid] },
    });

    const meta = (message.metadata ?? {}) as { mentions?: unknown };
    expect(Array.isArray(meta.mentions)).toBe(true);
    expect(meta.mentions).toEqual([obsA.uuid]);
  });

  // addParticipant seeds the new participant with mode="full" per its schema
  // default; explicitly verifying newcomers don't silently become mention_only
  // is out of scope here (covered by chat-upgrade.test.ts) — but pinning the
  // "late-joiner does not retroactively receive the earlier message" invariant
  // is.
  it("a participant added AFTER the message does not retroactively receive it", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, chat } = await setupGroup(app, uid);

    await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      {
        source: "api",
        format: "text",
        content: "earlier chatter",
      },
      { allowRecipientlessSend: true },
    );

    const { agent: late } = await createTestAgent(app, { name: `mf-late-${uid}` });
    await app.db.update(agents).set({ managerId: sender.memberId }).where(eq(agents.uuid, late.uuid));
    await addParticipant(app.db, chat.id, sender.agent.uuid, { agentId: late.uuid });

    expect(await inboxEntriesFor(app, chat.id, late.uuid)).toHaveLength(0);
  });

  it("does not emit a `mentions` field on the message when no mentions were declared", async () => {
    // Keep the wire payload lean: an empty mention set should leave the
    // metadata object untouched rather than stamping `mentions: []`.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, chat } = await setupGroup(app, uid);
    const { message } = await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      {
        source: "api",
        format: "text",
        content: "generic chatter",
      },
      { allowRecipientlessSend: true },
    );
    const meta = (message.metadata ?? {}) as Record<string, unknown>;
    expect(meta).not.toHaveProperty("mentions");
  });

  it("addressedToAgentIds wakes the recipient even without metadata.mentions (github-delivery pattern)", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, obsA, chat } = await setupGroup(app, uid);

    await sendMessage(
      app.db,
      chat.id,
      sender.agent.uuid,
      { source: "api", format: "text", content: "system event" },
      { addressedToAgentIds: [obsA.uuid] },
    );

    expect(await inboxEntriesFor(app, chat.id, obsA.uuid)).toHaveLength(1);
  });

  it("rejects a no-recipient send: there is no no-mention path", async () => {
    // A group chat has no no-recipient send. A message that names no one is
    // rejected regardless of caller — there is no broadcast opt-in that lets
    // an un-addressed message through. Enforcement is the default now, so a
    // bare send carries no flag and still rejects.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const { sender, chat } = await setupGroup(app, uid);

    await expect(
      sendMessage(app.db, chat.id, sender.agent.uuid, { source: "api", format: "text", content: "no recipient" }),
    ).rejects.toThrow(/recipient/i);
  });
});
