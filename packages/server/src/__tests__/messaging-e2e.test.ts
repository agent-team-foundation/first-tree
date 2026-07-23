import { describe, expect, it } from "vitest";
import { createAgent, getAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import { ackEntryByIdForBoundAgents, pollInbox } from "../services/inbox.js";
import { listMessages, sendMessage } from "../services/message.js";
import { createAdminContext, useTestApp } from "./helpers.js";

/**
 * End-to-end coverage for the surviving messaging scenarios after the
 * cross-chat reply-routing mechanism was removed (see
 * first-tree-context PR #281). Group-chat mention filtering and
 * message-immutability invariants still hold and are pinned here.
 */

type Entry = Awaited<ReturnType<typeof pollInbox>>[number];

function skipForMode(entry: Entry, myAgentId: string): boolean {
  if (entry.message.recipientMode !== "mention_only") return false;
  const raw = (entry.message.metadata as { mentions?: unknown }).mentions;
  if (!Array.isArray(raw)) return true;
  return !raw.some((m) => m === myAgentId);
}

async function ackAll(
  app: { db: Parameters<typeof ackEntryByIdForBoundAgents>[0] },
  entries: Entry[],
  inboxId: string,
) {
  for (const e of entries) {
    await ackEntryByIdForBoundAgents(app.db, e.id, [inboxId]);
  }
}

describe("messaging E2E — group-chat mention scenarios", () => {
  const getApp = useTestApp();

  it("Case C: group @mention activates only the targeted agent (Mention-filter invariant)", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app, { username: `e2ec-${Date.now()}` });
    const a1 = await getAgent(app.db, ctx.humanAgentUuid);
    const b1 = await createAgent(app.db, {
      name: `e2ec-b1-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const b2 = await createAgent(app.db, {
      name: `e2ec-b2-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    // Group with human + two agents. a1 owner (full), b1 & b2 are added as
    // members — createChat keeps them at default "full". We simulate the
    // Case C post-upgrade state by relying on the agent-side @mention logic
    // only: modes matter for dispatcher output, so set them.
    const chat = await createChat(app.db, a1.uuid, {
      type: "group",
      participantIds: [b1.uuid, b2.uuid],
    });
    const { chatMembership } = await import("../db/schema/chat-membership.js");
    const { and, eq, inArray } = await import("drizzle-orm");
    await app.db
      .update(chatMembership)
      .set({ mode: "mention_only" })
      .where(and(eq(chatMembership.chatId, chat.id), inArray(chatMembership.agentId, [b1.uuid, b2.uuid])));

    // Human messages with explicit mention of b1.
    await sendMessage(app.db, chat.id, a1.uuid, {
      source: "api",
      format: "text",
      content: "@b1 please look",
      metadata: { mentions: [b1.uuid] },
    });

    const b1Pulled = await pollInbox(app.db, b1.inboxId, 10);
    const b2Pulled = await pollInbox(app.db, b2.inboxId, 10);
    // Server-side fan-out is authoritative for the mention filter:
    // mention_only + not mentioned → no inbox_entry written. b2 therefore
    // receives nothing.
    expect(b1Pulled).toHaveLength(1);
    expect(b2Pulled).toHaveLength(0);

    // b1's payload still carries its participant mode so the dispatcher /
    // handler can read context if needed.
    expect(b1Pulled[0]?.message.recipientMode).toBe("mention_only");
    expect(skipForMode(b1Pulled[0] as Entry, b1.uuid)).toBe(false);
  });

  it("Case D: b1's reply with explicit @b3 activates b3 (not b2)", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app, { username: `e2ed-${Date.now()}` });
    const a1 = await getAgent(app.db, ctx.humanAgentUuid);
    const b1 = await createAgent(app.db, {
      name: `e2ed-b1-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const b2 = await createAgent(app.db, {
      name: `e2ed-b2-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const b3 = await createAgent(app.db, {
      name: `e2ed-b3-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });

    const chat = await createChat(app.db, a1.uuid, {
      type: "group",
      participantIds: [b1.uuid, b2.uuid, b3.uuid],
    });
    const { chatMembership } = await import("../db/schema/chat-membership.js");
    const { and, eq, inArray } = await import("drizzle-orm");
    await app.db
      .update(chatMembership)
      .set({ mode: "mention_only" })
      .where(and(eq(chatMembership.chatId, chat.id), inArray(chatMembership.agentId, [b1.uuid, b2.uuid, b3.uuid])));

    // a1 pings b1.
    const ping = await sendMessage(app.db, chat.id, a1.uuid, {
      source: "api",
      format: "text",
      content: "@b1 thoughts?",
      metadata: { mentions: [b1.uuid] },
    });

    // b1's runtime processes, then sends to its agent peer b3. (This reply
    // addresses agent b3, not the human a1; a1 stays in the loop as a full-mode
    // participant. A plain `chat send <a1>` would also be allowed, but this
    // case routes to b3.)
    await pollInbox(app.db, b1.inboxId, 10);
    await sendMessage(app.db, chat.id, b1.uuid, {
      source: "api",
      format: "text",
      content: "rough plan. @b3 can you sanity-check?",
      inReplyTo: ping.message.id,
      metadata: { mentions: [b3.uuid] },
    });

    // Each observer polls its inbox for both messages.
    const b2All = await pollInbox(app.db, b2.inboxId, 10);
    const b3All = await pollInbox(app.db, b3.inboxId, 10);
    const a1All = await pollInbox(app.db, a1.inboxId, 10);

    // b2 must not receive EITHER message — server-authoritative fan-out
    // withholds inbox_entries from mention_only participants not in the
    // mention set.
    expect(b2All).toHaveLength(0);
    // b3 receives b1's reply mentioning him — must NOT skip that one.
    const b3Reply = b3All.find((e) => e.message.inReplyTo === ping.message.id);
    expect(b3Reply).toBeDefined();
    if (b3Reply) expect(skipForMode(b3Reply, b3.uuid)).toBe(false);
    // a1 is full-mode — never skipped regardless of mentions.
    for (const e of a1All) {
      expect(skipForMode(e, a1.uuid)).toBe(false);
    }
  });

  it("Message-immutability invariant: edits do not re-route or re-fan out", async () => {
    // Messages are immutable (UUID v7 ordering + append-only fan-out).
    // `editMessage` only patches content in-place; it must NOT trigger a
    // second fan-out and must NOT change envelope fields.
    const app = getApp();
    const ctx = await createAdminContext(app, { username: `e2eimm-${Date.now()}` });
    const b1 = await createAgent(app.db, {
      name: `e2eimm-b1-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const b2 = await createAgent(app.db, {
      name: `e2eimm-b2-${Date.now()}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    const c1 = await createChat(app.db, b1.uuid, { type: "group", participantIds: [b2.uuid] });

    const m1 = await sendMessage(app.db, c1.id, b1.uuid, {
      source: "api",
      format: "text",
      content: "first cut",
      metadata: { mentions: [b2.uuid] },
    });

    // b2 drains so we observe the PRE-edit fan-out count (1 entry).
    const b2Before = await pollInbox(app.db, b2.inboxId, 10);
    expect(b2Before).toHaveLength(1);
    await ackAll(app, b2Before, b2.inboxId);

    const { editMessage } = await import("../services/message.js");
    await editMessage(app.db, null, c1.id, m1.message.id, b1.uuid, { content: "first cut — revised" });

    // No new inbox entries should have been written — b2 pulls nothing.
    const b2After = await pollInbox(app.db, b2.inboxId, 10);
    expect(b2After).toHaveLength(0);

    // `metadata.editedAt` is the only observable trace of the edit.
    const msgs = await listMessages(app.db, c1.id, 10);
    const edited = msgs.items.find((m) => m.id === m1.message.id);
    if (!edited) throw new Error("edited message missing");
    expect(edited.content).toBe("first cut — revised");
    expect((edited.metadata as { editedAt?: string }).editedAt).toBeTypeOf("string");
  });
});
