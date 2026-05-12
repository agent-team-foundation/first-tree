import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { findOrCreateChatForChannel } from "../services/adapter-mapping.js";
import { createAgent } from "../services/agent.js";
import { addParticipant, createChat, ensureParticipant, findOrCreateDirectChat } from "../services/chat.js";
import { createMeChat } from "../services/me-chat.js";
import { createAdminContext, createTestAgent, useTestApp } from "./helpers.js";

/**
 * Phase 1 invariant matrix — pins
 *
 *   `chat_membership.mode` (for `access_mode = 'speaker'` rows) is derived
 *   from `(chats.type, agents.type)` at every write path; no caller can
 *   land in an inconsistent state.
 *
 * Each `it` exercises one entrypoint, then directly inspects the
 * `chat_membership` row to assert the post-write mode. If a future
 * refactor reintroduces a hand-rolled mode somewhere, exactly one row in
 * this matrix flips.
 *
 * See docs/chat-participant-mode-fix-design.md §3.5 and
 * proposals/chat-data-model-restructure.20260512.md §8 (post-restructure
 * the underlying table is `chat_membership` rather than `chat_participants`).
 */

async function loadMode(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  chatId: string,
  agentId: string,
): Promise<string | undefined> {
  const [row] = await app.db
    .select({ mode: chatMembership.mode })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        eq(chatMembership.agentId, agentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  return row?.mode;
}

describe("Phase 1 invariant: chat_membership.mode is server-derived", () => {
  const getApp = useTestApp();

  it("createChat / direct + human + agent → both 'full'", async () => {
    const app = getApp();
    const humanCtx = await createTestAgent(app, { type: "human" });
    const { agent: peer } = await createTestAgent(app, { type: "autonomous_agent" });

    const chat = await createChat(app.db, humanCtx.agent.uuid, {
      type: "direct",
      participantIds: [peer.uuid],
    });

    expect(await loadMode(app, chat.id, humanCtx.agent.uuid)).toBe("full");
    expect(await loadMode(app, chat.id, peer.uuid)).toBe("full");
  });

  it("createChat / direct + agent + agent → both 'mention_only' (anti-echo)", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { type: "autonomous_agent" });
    const { agent: b } = await createTestAgent(app, { type: "autonomous_agent" });

    const chat = await createChat(app.db, a.agent.uuid, {
      type: "direct",
      participantIds: [b.uuid],
    });

    expect(await loadMode(app, chat.id, a.agent.uuid)).toBe("mention_only");
    expect(await loadMode(app, chat.id, b.uuid)).toBe("mention_only");
  });

  it("createChat / group + human + agent + agent → human 'full', agents 'mention_only'", async () => {
    const app = getApp();
    const humanCtx = await createTestAgent(app, { type: "human" });
    const { agent: ag1 } = await createTestAgent(app, { type: "autonomous_agent" });
    const { agent: ag2 } = await createTestAgent(app, { type: "autonomous_agent" });

    const chat = await createChat(app.db, humanCtx.agent.uuid, {
      type: "group",
      participantIds: [ag1.uuid, ag2.uuid],
    });

    expect(await loadMode(app, chat.id, humanCtx.agent.uuid)).toBe("full");
    expect(await loadMode(app, chat.id, ag1.uuid)).toBe("mention_only");
    expect(await loadMode(app, chat.id, ag2.uuid)).toBe("mention_only");
  });

  it("createChat / group + 3 agents → all 'mention_only'", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { type: "autonomous_agent" });
    const { agent: b } = await createTestAgent(app, { type: "autonomous_agent" });
    const { agent: c } = await createTestAgent(app, { type: "autonomous_agent" });

    const chat = await createChat(app.db, a.agent.uuid, {
      type: "group",
      participantIds: [b.uuid, c.uuid],
    });

    expect(await loadMode(app, chat.id, a.agent.uuid)).toBe("mention_only");
    expect(await loadMode(app, chat.id, b.uuid)).toBe("mention_only");
    expect(await loadMode(app, chat.id, c.uuid)).toBe("mention_only");
  });

  it("addParticipant upgrade / direct → group re-grades existing non-humans to 'mention_only'", async () => {
    const app = getApp();
    const humanCtx = await createTestAgent(app, { type: "human" });
    const { agent: ag1 } = await createTestAgent(app, { type: "autonomous_agent" });
    const { agent: ag2 } = await createTestAgent(app, { type: "autonomous_agent" });

    // Direct chat: human + agent → both 'full'.
    const chat = await createChat(app.db, humanCtx.agent.uuid, {
      type: "direct",
      participantIds: [ag1.uuid],
    });
    expect(await loadMode(app, chat.id, ag1.uuid)).toBe("full");

    // Adding ag2 upgrades to group and re-grades ag1 (non-human) to
    // mention_only. The human stays 'full'.
    await addParticipant(app.db, chat.id, humanCtx.agent.uuid, { agentId: ag2.uuid });

    expect(await loadMode(app, chat.id, humanCtx.agent.uuid)).toBe("full");
    expect(await loadMode(app, chat.id, ag1.uuid)).toBe("mention_only");
    expect(await loadMode(app, chat.id, ag2.uuid)).toBe("mention_only");
  });

  it("createMeChat / group seeds non-humans as 'mention_only' on first write (root-cause bug fix)", async () => {
    // This is the failing path from design §1.1: the original bug created
    // group chats whose agent participants ended up in 'full' because
    // `createMeChat`'s ad-hoc `isDirectAgentOnly` branch only handled the
    // direct-agent-only special case.
    const app = getApp();
    const admin = await createAdminContext(app);
    const ag1 = await createAgent(app.db, {
      name: `inv-mc-a-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Agent A",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const ag2 = await createAgent(app.db, {
      name: `inv-mc-b-${crypto.randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Agent B",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [ag1.uuid, ag2.uuid],
    });

    expect(await loadMode(app, chatId, admin.humanAgentUuid)).toBe("full");
    expect(await loadMode(app, chatId, ag1.uuid)).toBe("mention_only");
    expect(await loadMode(app, chatId, ag2.uuid)).toBe("mention_only");
  });

  it("findOrCreateDirectChat / human + agent → both 'full'", async () => {
    const app = getApp();
    const humanCtx = await createTestAgent(app, { type: "human" });
    const { agent: peer } = await createTestAgent(app, { type: "autonomous_agent" });

    const chat = await findOrCreateDirectChat(app.db, humanCtx.agent.uuid, peer.uuid);

    expect(await loadMode(app, chat.id, humanCtx.agent.uuid)).toBe("full");
    expect(await loadMode(app, chat.id, peer.uuid)).toBe("full");
  });

  it("findOrCreateDirectChat / agent + agent → both 'mention_only'", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { type: "autonomous_agent" });
    const { agent: b } = await createTestAgent(app, { type: "autonomous_agent" });

    const chat = await findOrCreateDirectChat(app.db, a.agent.uuid, b.uuid);

    expect(await loadMode(app, chat.id, a.agent.uuid)).toBe("mention_only");
    expect(await loadMode(app, chat.id, b.uuid)).toBe("mention_only");
  });

  it("ensureParticipant on a group chat seeds the new non-human at 'mention_only'", async () => {
    const app = getApp();
    const humanCtx = await createTestAgent(app, { type: "human" });
    const { agent: ag1 } = await createTestAgent(app, { type: "autonomous_agent" });
    const { agent: ag2 } = await createTestAgent(app, { type: "autonomous_agent" });
    const { agent: late } = await createTestAgent(app, { type: "autonomous_agent" });

    const chat = await createChat(app.db, humanCtx.agent.uuid, {
      type: "group",
      participantIds: [ag1.uuid, ag2.uuid],
    });

    await ensureParticipant(app.db, chat.id, late.uuid);

    expect(await loadMode(app, chat.id, late.uuid)).toBe("mention_only");
  });

  it("findOrCreateChatForChannel / IM adapter pair (bot + human sender) → both 'full'", async () => {
    const app = getApp();
    const botCtx = await createTestAgent(app, { type: "autonomous_agent" });
    // The IM adapter binds an external user to a `human` agent — match that
    // shape with a fresh human agent in the same org as the bot.
    const senderUuid = crypto.randomUUID();
    await app.db.insert(agents).values({
      uuid: senderUuid,
      name: `inv-im-sender-${crypto.randomUUID().slice(0, 6)}`,
      organizationId: botCtx.organizationId,
      type: "human",
      displayName: "IM Sender",
      inboxId: `inbox_${senderUuid}`,
      managerId: botCtx.memberId,
    });
    const chatId = await findOrCreateChatForChannel(app.db, {
      platform: "feishu",
      externalChannelId: `oc-inv-${crypto.randomUUID().slice(0, 8)}`,
      chatType: "p2p",
      botAgentId: botCtx.agent.uuid,
      senderAgentId: senderUuid,
    });

    expect(await loadMode(app, chatId, botCtx.agent.uuid)).toBe("full");
    expect(await loadMode(app, chatId, senderUuid)).toBe("full");
  });
});
