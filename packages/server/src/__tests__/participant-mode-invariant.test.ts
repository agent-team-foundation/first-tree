import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { createAgent } from "../services/agent.js";
import { addParticipant, createChat, ensureParticipant } from "../services/chat.js";
import { createMeChat } from "../services/me-chat.js";
import { createAdminContext, createTestAgent, useTestApp } from "./helpers.js";

/**
 * v2 chat_membership.mode invariant — pins
 *
 *   `chat_membership.mode` for `access_mode = 'speaker'` rows is written as
 *   the constant `'mention_only'` at every speaker-write path. The column
 *   is decision-inert; no caller can drift back to the v1
 *   `(chats.type, agents.type)` derivation that this file used to gate.
 *
 * Each `it` exercises one entrypoint, then inspects the freshly-written
 * `chat_membership` row. If a future refactor reintroduces a hand-rolled
 * mode somewhere, the corresponding row in this matrix flips.
 *
 * See proposals/hub-chat-message-v2-simplify-mode.20260520.md.
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

describe("v2 invariant: chat_membership.mode is the constant 'mention_only'", () => {
  const getApp = useTestApp();

  it("createChat / human + agent (size=2) → both 'mention_only'", async () => {
    const app = getApp();
    const humanCtx = await createTestAgent(app, { type: "human" });
    const { agent: peer } = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, humanCtx.agent.uuid, {
      type: "group",
      participantIds: [peer.uuid],
    });

    expect(await loadMode(app, chat.id, humanCtx.agent.uuid)).toBe("mention_only");
    expect(await loadMode(app, chat.id, peer.uuid)).toBe("mention_only");
  });

  it("createChat / agent + agent (size=2) → both 'mention_only'", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { type: "agent" });
    const { agent: b } = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, a.agent.uuid, {
      type: "group",
      participantIds: [b.uuid],
    });

    expect(await loadMode(app, chat.id, a.agent.uuid)).toBe("mention_only");
    expect(await loadMode(app, chat.id, b.uuid)).toBe("mention_only");
  });

  it("createChat / group (size=3, human + 2 agents) → all 'mention_only'", async () => {
    const app = getApp();
    const humanCtx = await createTestAgent(app, { type: "human" });
    const { agent: ag1 } = await createTestAgent(app, { type: "agent" });
    const { agent: ag2 } = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, humanCtx.agent.uuid, {
      type: "group",
      participantIds: [ag1.uuid, ag2.uuid],
    });

    expect(await loadMode(app, chat.id, humanCtx.agent.uuid)).toBe("mention_only");
    expect(await loadMode(app, chat.id, ag1.uuid)).toBe("mention_only");
    expect(await loadMode(app, chat.id, ag2.uuid)).toBe("mention_only");
  });

  it("createChat / group (size=3, 3 agents) → all 'mention_only'", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { type: "agent" });
    const { agent: b } = await createTestAgent(app, { type: "agent" });
    const { agent: c } = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, a.agent.uuid, {
      type: "group",
      participantIds: [b.uuid, c.uuid],
    });

    expect(await loadMode(app, chat.id, a.agent.uuid)).toBe("mention_only");
    expect(await loadMode(app, chat.id, b.uuid)).toBe("mention_only");
    expect(await loadMode(app, chat.id, c.uuid)).toBe("mention_only");
  });

  it("addParticipant on a 2-speaker chat → new + existing rows all 'mention_only' (no re-grade needed)", async () => {
    const app = getApp();
    const humanCtx = await createTestAgent(app, { type: "human" });
    const { agent: ag1 } = await createTestAgent(app, { type: "agent" });
    const { agent: ag2 } = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, humanCtx.agent.uuid, {
      type: "group",
      participantIds: [ag1.uuid],
    });
    expect(await loadMode(app, chat.id, ag1.uuid)).toBe("mention_only");

    await addParticipant(app.db, chat.id, humanCtx.agent.uuid, { agentId: ag2.uuid });

    expect(await loadMode(app, chat.id, humanCtx.agent.uuid)).toBe("mention_only");
    expect(await loadMode(app, chat.id, ag1.uuid)).toBe("mention_only");
    expect(await loadMode(app, chat.id, ag2.uuid)).toBe("mention_only");
  });

  it("createMeChat / group seeds every speaker as 'mention_only'", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const ag1 = await createAgent(app.db, {
      name: `inv-mc-a-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Agent A",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const ag2 = await createAgent(app.db, {
      name: `inv-mc-b-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Agent B",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [ag1.uuid, ag2.uuid],
    });

    expect(await loadMode(app, chatId, admin.humanAgentUuid)).toBe("mention_only");
    expect(await loadMode(app, chatId, ag1.uuid)).toBe("mention_only");
    expect(await loadMode(app, chatId, ag2.uuid)).toBe("mention_only");
  });

  it("ensureParticipant on a group chat seeds the new speaker as 'mention_only'", async () => {
    const app = getApp();
    const humanCtx = await createTestAgent(app, { type: "human" });
    const { agent: ag1 } = await createTestAgent(app, { type: "agent" });
    const { agent: ag2 } = await createTestAgent(app, { type: "agent" });
    const { agent: late } = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, humanCtx.agent.uuid, {
      type: "group",
      participantIds: [ag1.uuid, ag2.uuid],
    });

    await ensureParticipant(app.db, chat.id, late.uuid);

    expect(await loadMode(app, chat.id, late.uuid)).toBe("mention_only");
  });
});
