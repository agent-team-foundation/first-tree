import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agents } from "../db/schema/agents.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { createChat } from "../services/chat.js";
import {
  LOOP_OBSERVATION_SHORT_CHARS,
  LOOP_OBSERVATION_TIME_WINDOW_MS,
  LOOP_OBSERVATION_WINDOW,
  observeLoopPattern,
  sendMessage,
} from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Pins the L4 server-side loop observation in `services/message.ts`. The
 * detector emits a structured warn log (`metric: loop_pattern_observed_total`)
 * when six conjunctive conditions all hold across the most recent
 * `LOOP_OBSERVATION_WINDOW` messages of a chat:
 *
 *   C1 — every message is `format=text`
 *   C2 — every sender is non-human
 *   C3 — exactly two senders, strictly alternating
 *   C4 — strict `inReplyTo` chain
 *   C5 — every body (stripped of leading `@<name>` tokens) is short
 *   C6 — the whole window fits in the time budget
 *
 * The observer is a pure side-channel. It MUST never modify `notify` or any
 * other field that affects fan-out — that's the load-bearing invariant
 * pinned by the dedicated "does not alter fan-out" test at the bottom.
 */
describe("L4 loop-pattern observation (services/message.ts)", () => {
  const getApp = useTestApp();

  type WindowSpec = {
    senderId: string;
    content: string;
    format?: string;
    /** Milliseconds before "now" — newer values are smaller (or 0). */
    ageMs: number;
  };

  /**
   * Insert messages directly so we can control senders, content, format, and
   * timestamps with surgical precision. Each message's `inReplyTo` points at
   * the message inserted *immediately before it* — building the strict reply
   * chain C4 asks for. Pass `format: "markdown"` on one entry to break C1,
   * `content: "longer than ten chars"` to break C5, etc.
   */
  async function seedWindow(app: ReturnType<typeof getApp>, chatId: string, specs: WindowSpec[]): Promise<string[]> {
    const now = Date.now();
    const ids: string[] = [];
    let previousId: string | null = null;
    // Insert chronological-oldest-first so each new message can reference
    // the prior one via inReplyTo; ageMs interprets larger = older, so we
    // sort high-to-low.
    const sorted = [...specs].sort((a, b) => b.ageMs - a.ageMs);
    for (const spec of sorted) {
      const id = randomUUID();
      await app.db.insert(messages).values({
        id,
        chatId,
        senderId: spec.senderId,
        format: spec.format ?? "text",
        content: spec.content,
        metadata: {},
        inReplyTo: previousId,
        createdAt: new Date(now - spec.ageMs),
      });
      ids.push(id);
      previousId = id;
    }
    return ids;
  }

  async function setupAgentPair(prefix: string) {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a = await createTestAgent(app, { name: `${prefix}-a-${uid}` });
    const { agent: b } = await createTestAgent(app, { name: `${prefix}-b-${uid}` });
    const chat = await createChat(app.db, a.agent.uuid, {
      type: "group",
      participantIds: [b.uuid],
    });
    return { app, a, b, chat };
  }

  // A loop window of 4 short, alternating, recent, reply-chained messages
  // from two non-human agents — the canonical bug case. ageMs in seconds-ago,
  // newest-first.
  function loopSpecs(aId: string, bId: string): WindowSpec[] {
    return [
      // Oldest = bottom of the chain. agent A starts.
      { senderId: aId, content: "@b .", ageMs: 4_000 },
      { senderId: bId, content: "@a (idle)", ageMs: 3_000 },
      { senderId: aId, content: "@b .", ageMs: 2_000 },
      { senderId: bId, content: "@a (idle)", ageMs: 1_000 },
    ];
  }

  it("triggers the observer when all six conditions hold (full match)", async () => {
    const { app, a, b, chat } = await setupAgentPair("lp-hit");
    const ids = await seedWindow(app, chat.id, loopSpecs(a.agent.uuid, b.uuid));

    const observer = vi.fn();
    await observeLoopPattern(app.db, chat.id, observer);

    expect(observer).toHaveBeenCalledTimes(1);
    const payload = observer.mock.calls[0]?.[0];
    expect(payload).toMatchObject({ chatId: chat.id });
    // Window comes back newest-first, matching the SELECT ordering. The
    // chain we built has the newest message at ids[length-1]; the SELECT
    // ORDER BY desc puts it at recentMessageIds[0].
    expect(payload?.recentMessageIds[0]).toBe(ids[ids.length - 1]);
    expect(payload?.windowSpanMs).toBeLessThanOrEqual(LOOP_OBSERVATION_TIME_WINDOW_MS);
    expect(payload?.contentLengths).toHaveLength(LOOP_OBSERVATION_WINDOW);
    // Each stripped body is short — proves we measured length after
    // dropping the `@<name>` prefix, not before.
    for (const len of payload?.contentLengths ?? []) {
      expect(len).toBeLessThanOrEqual(LOOP_OBSERVATION_SHORT_CHARS);
    }
  });

  it("does NOT trigger when fewer than the window's worth of messages exist", async () => {
    const { app, a, b, chat } = await setupAgentPair("lp-short");
    // Only 3 messages; window is 4.
    await seedWindow(app, chat.id, [
      { senderId: a.agent.uuid, content: ".", ageMs: 3_000 },
      { senderId: b.uuid, content: ".", ageMs: 2_000 },
      { senderId: a.agent.uuid, content: ".", ageMs: 1_000 },
    ]);

    const observer = vi.fn();
    await observeLoopPattern(app.db, chat.id, observer);

    expect(observer).not.toHaveBeenCalled();
  });

  it("C1 — does NOT trigger if any message is not text format (e.g. markdown / question)", async () => {
    const { app, a, b, chat } = await setupAgentPair("lp-c1");
    const specs = loopSpecs(a.agent.uuid, b.uuid);
    // Flip one entry to markdown — non-text turns are typically real
    // information (tables / file refs) and should never count as echo.
    if (specs[1]) specs[1].format = "markdown";
    await seedWindow(app, chat.id, specs);

    const observer = vi.fn();
    await observeLoopPattern(app.db, chat.id, observer);
    expect(observer).not.toHaveBeenCalled();
  });

  it("C2 — does NOT trigger if a human sat in the window", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a = await createTestAgent(app, { name: `lp-c2-a-${uid}` });
    const human = await createTestAgent(app, { name: `lp-c2-h-${uid}`, type: "human" });
    const chat = await createChat(app.db, a.agent.uuid, {
      type: "group",
      participantIds: [human.agent.uuid],
    });
    // A and a human alternating — looks like a loop on the surface, but a
    // human participating means any "courtesy" pattern is actually a person
    // typing. Never flag.
    await seedWindow(app, chat.id, [
      { senderId: a.agent.uuid, content: ".", ageMs: 4_000 },
      { senderId: human.agent.uuid, content: ".", ageMs: 3_000 },
      { senderId: a.agent.uuid, content: ".", ageMs: 2_000 },
      { senderId: human.agent.uuid, content: ".", ageMs: 1_000 },
    ]);

    const observer = vi.fn();
    await observeLoopPattern(app.db, chat.id, observer);
    expect(observer).not.toHaveBeenCalled();
  });

  it("C3 — does NOT trigger if more than two distinct senders are in the window", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a = await createTestAgent(app, { name: `lp-c3-a-${uid}` });
    const { agent: b } = await createTestAgent(app, { name: `lp-c3-b-${uid}` });
    const { agent: c } = await createTestAgent(app, { name: `lp-c3-c-${uid}` });
    const chat = await createChat(app.db, a.agent.uuid, {
      type: "group",
      participantIds: [b.uuid, c.uuid],
    });
    // Three senders mixed into the window — even with short content this is
    // multi-agent coordination, not a two-agent ping-pong.
    await seedWindow(app, chat.id, [
      { senderId: a.agent.uuid, content: ".", ageMs: 4_000 },
      { senderId: b.uuid, content: ".", ageMs: 3_000 },
      { senderId: c.uuid, content: ".", ageMs: 2_000 },
      { senderId: a.agent.uuid, content: ".", ageMs: 1_000 },
    ]);

    const observer = vi.fn();
    await observeLoopPattern(app.db, chat.id, observer);
    expect(observer).not.toHaveBeenCalled();
  });

  it("C3 — does NOT trigger if two senders are present but not strictly alternating", async () => {
    const { app, a, b, chat } = await setupAgentPair("lp-c3b");
    // Two senders but A speaks twice in a row — broken alternation.
    await seedWindow(app, chat.id, [
      { senderId: a.agent.uuid, content: ".", ageMs: 4_000 },
      { senderId: a.agent.uuid, content: ".", ageMs: 3_000 },
      { senderId: b.uuid, content: ".", ageMs: 2_000 },
      { senderId: a.agent.uuid, content: ".", ageMs: 1_000 },
    ]);

    const observer = vi.fn();
    await observeLoopPattern(app.db, chat.id, observer);
    expect(observer).not.toHaveBeenCalled();
  });

  it("C4 — does NOT trigger if the inReplyTo chain is broken", async () => {
    const { app, a, b, chat } = await setupAgentPair("lp-c4");
    // Insert messages WITHOUT inReplyTo — same alternation and content but
    // no explicit threading. This is e.g. two agents posting parallel
    // updates, not replies to each other.
    const now = Date.now();
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const senders = [a.agent.uuid, b.uuid, a.agent.uuid, b.uuid];
    for (let i = 0; i < 4; i++) {
      await app.db.insert(messages).values({
        id: ids[i] ?? randomUUID(),
        chatId: chat.id,
        senderId: senders[i] ?? a.agent.uuid,
        format: "text",
        content: ".",
        metadata: {},
        inReplyTo: null,
        createdAt: new Date(now - (4 - i) * 1000),
      });
    }

    const observer = vi.fn();
    await observeLoopPattern(app.db, chat.id, observer);
    expect(observer).not.toHaveBeenCalled();
  });

  it("C5 — does NOT trigger if any message body (after stripping mentions) is longer than the short threshold", async () => {
    const { app, a, b, chat } = await setupAgentPair("lp-c5");
    const specs = loopSpecs(a.agent.uuid, b.uuid);
    // Replace one body with something that has real information — even with
    // the leading `@b` prefix stripped, the remainder is far over 10 chars.
    if (specs[2]) specs[2].content = "@b PR #42 merged, deploying to staging now";
    await seedWindow(app, chat.id, specs);

    const observer = vi.fn();
    await observeLoopPattern(app.db, chat.id, observer);
    expect(observer).not.toHaveBeenCalled();
  });

  it("C6 — does NOT trigger if the window spans more time than the budget allows", async () => {
    const { app, a, b, chat } = await setupAgentPair("lp-c6");
    // Same pattern but stretched across a longer interval — agents working
    // through something over minutes is normal collaboration, even if each
    // message happens to be short.
    const oldEnough = LOOP_OBSERVATION_TIME_WINDOW_MS + 5_000;
    await seedWindow(app, chat.id, [
      { senderId: a.agent.uuid, content: "@b .", ageMs: oldEnough },
      { senderId: b.uuid, content: "@a .", ageMs: oldEnough - 1_000 },
      { senderId: a.agent.uuid, content: "@b .", ageMs: 2_000 },
      { senderId: b.uuid, content: "@a .", ageMs: 1_000 },
    ]);

    const observer = vi.fn();
    await observeLoopPattern(app.db, chat.id, observer);
    expect(observer).not.toHaveBeenCalled();
  });

  it("does NOT alter fan-out behaviour — `notify` is identical with and without observation triggering", async () => {
    // The load-bearing invariant: observation is a side channel. Even when
    // a loop pattern matches, `sendMessage` must still create the same
    // inbox entries with the same `notify` flags it would otherwise.
    // Drive this through the *real* sendMessage path so any future refactor
    // that accidentally lets the observer flip `notify` blows up here.
    const { app, a, b, chat } = await setupAgentPair("lp-fanout");
    // Pre-seed three messages so the fourth (sent via sendMessage) closes
    // the loop window. Each message must `@<peer>` to wake the mention_only
    // recipient — that's the L1 default for agent-only group chats.
    await seedWindow(app, chat.id, [
      { senderId: a.agent.uuid, content: `@${b.name} .`, ageMs: 3_500 },
      { senderId: b.uuid, content: `@${a.agent.name} .`, ageMs: 2_500 },
      { senderId: a.agent.uuid, content: `@${b.name} .`, ageMs: 1_500 },
    ]);
    // 4th send through the real service — the post-tx observer will fire
    // (loop matches) but must NOT touch any fan-out state.
    const result = await sendMessage(app.db, chat.id, b.uuid, {
      format: "text",
      content: `@${a.agent.name} .`,
      metadata: { mentions: [a.agent.uuid] },
    });
    expect(result.recipients.length).toBeGreaterThan(0);

    // The peer's inbox got the new message as a notify=true entry — the
    // observation did not silence it.
    const [aInbox] = await app.db
      .select({ inboxId: agents.inboxId })
      .from(agents)
      .where(eq(agents.uuid, a.agent.uuid))
      .limit(1);
    expect(aInbox).toBeDefined();
    const notified = await app.db
      .select({ messageId: inboxEntries.messageId })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, aInbox?.inboxId ?? ""),
          eq(inboxEntries.chatId, chat.id),
          eq(inboxEntries.notify, true),
          eq(inboxEntries.messageId, result.message.id),
        ),
      );
    expect(notified).toHaveLength(1);
  });
});
