import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createMeChat, listMeChats } from "../services/me-chat.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

/**
 * `MeChatRow.workingAgentIds` derivation.
 *
 * Decision (chat-status-icons preview spec §⑦.② / §⑦.⑦):
 *
 *   - The field is populated server-side from the participants' GLOBAL
 *     `agent_presence.runtime_state` (PK lookup, zero new index).
 *   - Per-chat precision is NOT modelled — an agent working in any chat
 *     surfaces as `working` on every chat they speak in. The web layer
 *     compensates by only rendering the working ring for direct chats
 *     and deferring group-chat working signals to a future per-chat
 *     data source.
 *
 * This file pins the field contract, the speaker-only inclusion rule,
 * the runtime-state filter, and the lazy-presence-row default.
 */
describe("listMeChats: workingAgentIds derivation from agent_presence", () => {
  const getApp = useTestApp();

  async function setPresence(agentId: string, runtimeState: string | null): Promise<void> {
    const app = getApp();
    await app.db.execute(sql`
      INSERT INTO agent_presence (agent_id, status, runtime_state)
      VALUES (${agentId}, 'online', ${runtimeState})
      ON CONFLICT (agent_id) DO UPDATE SET runtime_state = EXCLUDED.runtime_state
    `);
  }

  async function rowFor(chatId: string, viewerAgentId: string, organizationId: string) {
    const app = getApp();
    const { rows } = await listMeChats(app.db, viewerAgentId, organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
    });
    return rows.find((r) => r.chatId === chatId) ?? null;
  }

  it("empty array when no participant has runtime_state = 'working'", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `wa-empty-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    // peer is idle; agent_presence row may or may not exist — both should
    // resolve to "no working agents". Seed an explicit idle row to prove
    // the runtime_state filter (not the row's existence) drives the field.
    await setPresence(peer.agent.uuid, "idle");

    const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    expect(row?.workingAgentIds).toEqual([]);
  });

  it("includes the peer in 1-on-1 when its runtime_state = 'working'", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `wa-direct-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await setPresence(peer.agent.uuid, "working");

    const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    expect(row?.workingAgentIds).toEqual([peer.agent.uuid]);
  });

  it("emits empty array when agent_presence row is missing entirely (lazy presence)", async () => {
    // agent_presence is lazy-materialised — a freshly created agent has
    // no row until its first WS frame. The LEFT JOIN must tolerate this
    // and produce `workingAgentIds: []`, NOT crash on `runtime_state IS NULL`.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `wa-lazy-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    // No setPresence call — agent_presence row never exists.

    const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    expect(row?.workingAgentIds).toEqual([]);
  });

  it("error / idle / null states do NOT count as working", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `wa-err-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    for (const state of ["idle", "error", "blocked", null]) {
      await setPresence(peer.agent.uuid, state);
      const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
      expect(row?.workingAgentIds, `runtime_state=${state}`).toEqual([]);
    }

    await setPresence(peer.agent.uuid, "working");
    const final = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    expect(final?.workingAgentIds).toEqual([peer.agent.uuid]);
  });

  it("group chat: lists every speaker with runtime_state = 'working' (precision deferred to UI)", async () => {
    // Server is honest — it returns every working speaker. The web layer
    // is the one that decides to only render the ring for direct chats.
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `wag-1-${uid}` });
    const { agent: a2 } = await createTestAgent(app, { name: `wag-2-${uid}` });
    const { agent: a3 } = await createTestAgent(app, { name: `wag-3-${uid}` });

    // a1 creates a DM, then upgrades to group by adding a2 + a3 — uses
    // the standard createMeChat-then-add flow rather than raw INSERTs.
    const { chatId } = await createMeChat(app.db, a1.agent.uuid, a1.organizationId, {
      participantIds: [a2.uuid, a3.uuid],
    });

    await setPresence(a2.uuid, "working");
    await setPresence(a3.uuid, "working");

    const row = await rowFor(chatId, a1.agent.uuid, a1.organizationId);
    expect(row?.workingAgentIds.sort()).toEqual([a2.uuid, a3.uuid].sort());
  });

  it("watcher rows are excluded — only speakers can appear in workingAgentIds", async () => {
    // Mention candidacy and projection both target speakers; the working
    // signal follows the same rule. A watcher whose runtime_state is
    // 'working' must NOT surface on chats they only watch.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `wa-spk-${crypto.randomUUID().slice(0, 6)}` });
    const watcher = await createTestAgent(app, { name: `wa-w-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    // Forge a watcher row for `watcher` — they only watch, never speak.
    await app.db.execute(sql`
      INSERT INTO chat_membership (chat_id, agent_id, role, access_mode, mode, source)
      VALUES (${chatId}, ${watcher.agent.uuid}, 'member', 'watcher', 'full', 'manual')
      ON CONFLICT (chat_id, agent_id) DO NOTHING
    `);

    await setPresence(peer.agent.uuid, "idle");
    await setPresence(watcher.agent.uuid, "working");

    const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    // Speaker peer is idle, watcher is working but excluded → empty.
    expect(row?.workingAgentIds).toEqual([]);
  });
});
