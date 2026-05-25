import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Pins the L4 server-side silent-send form guard in `services/message.ts`
 * (step 2e). The guard mirrors the client-side `result-sink` silent-turn
 * protocol (§3.2 of the design) on the server entry point so that paths
 * NOT going through result-sink — the agent CLI `chat send`, AskUserQuestion,
 * external IM adapters, admin/web posts — get the same loop protection.
 *
 * The rule is purely formal:
 *   - content (after stripping leading `@<name>` tokens) is empty → fan-out
 *     emits notify=false for every recipient. The message row is still
 *     written so chat history is complete (silent context rows; same shape
 *     as L3 mention_only suppression).
 *   - any non-empty remainder ("." / "(待命中)" / "OK") → guard does not
 *     fire; fan-out follows the existing mention_only / full rules. Code
 *     never evaluates content language — that decision belongs to the
 *     agent prompt.
 */
describe("server-side silent-send form guard (L4 mirror of result-sink)", () => {
  const getApp = useTestApp();

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

  /** Build a 3-agent group: sender (full), obsA (mention_only), obsB (mention_only). */
  async function setupGroup(prefix: string) {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `${prefix}-s-${uid}` });
    const { agent: obsA } = await createTestAgent(app, { name: `${prefix}-a-${uid}` });
    const { agent: obsB } = await createTestAgent(app, { name: `${prefix}-b-${uid}` });
    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [obsA.uuid, obsB.uuid],
    });
    // createChat seeds agent-only groups as mention_only. Promote the sender
    // to full so the "full mode also gets silenced" branch is exercised when
    // the guard fires (mention_only recipients are silenced by L1 too — the
    // full sender's symmetric peer is what makes silent-send observable).
    await setParticipantMode(app, chat.id, sender.agent.uuid, "full");
    await setParticipantMode(app, chat.id, obsA.uuid, "mention_only");
    await setParticipantMode(app, chat.id, obsB.uuid, "mention_only");
    return { app, sender, obsA, obsB, chat };
  }

  async function inboxOf(app: ReturnType<typeof getApp>, agentUuid: string) {
    const [row] = await app.db
      .select({ inboxId: agents.inboxId })
      .from(agents)
      .where(eq(agents.uuid, agentUuid))
      .limit(1);
    return row?.inboxId ?? null;
  }

  /** All rows in a recipient's inbox for the given chat — both notify=true and notify=false. */
  async function allInboxEntries(app: ReturnType<typeof getApp>, chatId: string, agentUuid: string) {
    const inboxId = await inboxOf(app, agentUuid);
    if (!inboxId) return [];
    return app.db
      .select({ messageId: inboxEntries.messageId, notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, inboxId), eq(inboxEntries.chatId, chatId)));
  }

  it("Case 1: empty string content — message row is written, ALL fanout rows have notify=false", async () => {
    const { app, sender, obsA, obsB, chat } = await setupGroup("ss-empty");

    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "text",
      content: "",
    });

    // Returned recipients (notify=true subset) is empty — silent send.
    expect(result.recipients).toEqual([]);

    // Message row is still written: chat history must remain complete.
    const stored = await app.db
      .select({ id: messages.id, content: messages.content })
      .from(messages)
      .where(eq(messages.id, result.message.id))
      .limit(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).toBe("");

    // Both fan-out recipients got a row, BOTH notify=false (silent context).
    const aEntries = await allInboxEntries(app, chat.id, obsA.uuid);
    const bEntries = await allInboxEntries(app, chat.id, obsB.uuid);
    expect(aEntries.filter((e) => e.messageId === result.message.id)).toEqual([
      { messageId: result.message.id, notify: false },
    ]);
    expect(bEntries.filter((e) => e.messageId === result.message.id)).toEqual([
      { messageId: result.message.id, notify: false },
    ]);
  });

  it("Case 2: pure @-mention with no trailing content — silenced (mention stripped, remainder empty)", async () => {
    // This is the exact shape `chat send X ""` produces after server-side
    // normalizeMentionsInContent runs: the recipient's @ is prepended but
    // there's no actual message body. Without this guard the recipient
    // would be woken with an empty conversation turn.
    const { app, sender, obsA, obsB, chat } = await setupGroup("ss-pure-at");
    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "text",
      content: `@${obsA.name}`,
      metadata: { mentions: [obsA.uuid] },
    });

    expect(result.recipients).toEqual([]);

    const aEntries = await allInboxEntries(app, chat.id, obsA.uuid);
    const bEntries = await allInboxEntries(app, chat.id, obsB.uuid);
    expect(aEntries.find((e) => e.messageId === result.message.id)?.notify).toBe(false);
    expect(bEntries.find((e) => e.messageId === result.message.id)?.notify).toBe(false);
  });

  it("Case 3: whitespace-only content — silenced", async () => {
    const { app, sender, obsA, chat } = await setupGroup("ss-ws");
    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "text",
      content: "   \n\t  ",
    });

    expect(result.recipients).toEqual([]);

    const aEntries = await allInboxEntries(app, chat.id, obsA.uuid);
    expect(aEntries.find((e) => e.messageId === result.message.id)?.notify).toBe(false);
  });

  it("Case 4: single-character content '.' — guard does NOT fire, normal mention_only fan-out applies", async () => {
    // Form check has nothing to say about meaningfulness. A 1-char body is
    // non-empty; the agent prompt is the layer responsible for deciding
    // whether "." was a useful turn. We pin here that the code stays out
    // of that decision and routes normally.
    const { app, sender, obsA, obsB, chat } = await setupGroup("ss-dot");
    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "text",
      content: ".",
      // Explicitly @ obsA so mention_only fan-out wakes them; obsB stays
      // silent context (mention_only + not mentioned) per existing L1.
      metadata: { mentions: [obsA.uuid] },
    });

    // obsA's inbox includes the notify=true wake-up; recipients reflects it.
    expect(result.recipients.length).toBeGreaterThan(0);
    const aEntries = await allInboxEntries(app, chat.id, obsA.uuid);
    const bEntries = await allInboxEntries(app, chat.id, obsB.uuid);
    expect(aEntries.find((e) => e.messageId === result.message.id)?.notify).toBe(true);
    // obsB still gets a silent context row from the existing L1 rule, which
    // is independent of the silent-send guard.
    expect(bEntries.find((e) => e.messageId === result.message.id)?.notify).toBe(false);
  });

  it("Case 5: real informational content with mention — guard does NOT fire, no false positive on routine traffic", async () => {
    // The canonical "completed PR" / "modified /foo.ts" reply. Length is
    // irrelevant; the only thing that matters is "is there anything left
    // after stripping leading @<name>?". Yes → route normally.
    const { app, sender, obsA, obsB, chat } = await setupGroup("ss-real");
    const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
      source: "api",
      format: "text",
      content: `@${obsA.name} 完成 PR #42`,
      metadata: { mentions: [obsA.uuid] },
    });

    expect(result.recipients.length).toBeGreaterThan(0);
    const aEntries = await allInboxEntries(app, chat.id, obsA.uuid);
    const bEntries = await allInboxEntries(app, chat.id, obsB.uuid);
    expect(aEntries.find((e) => e.messageId === result.message.id)?.notify).toBe(true);
    expect(bEntries.find((e) => e.messageId === result.message.id)?.notify).toBe(false);
  });
});
