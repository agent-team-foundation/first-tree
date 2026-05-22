import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createMeChat, listMeChats, previewToolArgs, toLiveActivity } from "../services/me-chat.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

/**
 * `MeChatRow.engagedAgentIds` + `MeChatRow.liveActivity` derivation.
 *
 * - `engagedAgentIds` reflects `agent_chat_sessions(agent_id, chat_id).state
 *   === 'active'` for each speaker. Per-(agent, chat) — cross-chat noise from
 *   the old `agent_presence.runtime_state` path is gone by construction.
 * - `liveActivity` reflects the most recent `session_events` row for the
 *   chat: `tool_call` / `thinking` / `assistant_text` produce a live
 *   indicator; `turn_end` / `error` / nothing recent produce `null`.
 */
describe("listMeChats: engagedAgentIds derivation from agent_chat_sessions", () => {
  const getApp = useTestApp();

  async function setSessionState(agentId: string, chatId: string, state: string): Promise<void> {
    const app = getApp();
    await app.db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, updated_at)
      VALUES (${agentId}, ${chatId}, ${state}, NOW())
      ON CONFLICT (agent_id, chat_id) DO UPDATE SET state = EXCLUDED.state
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

  it("empty array when no participant has an active session for this chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `ea-empty-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await setSessionState(peer.agent.uuid, chatId, "suspended");

    const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    expect(row?.engagedAgentIds).toEqual([]);
  });

  it("includes the peer when its session for this chat is active", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `ea-direct-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await setSessionState(peer.agent.uuid, chatId, "active");

    const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    expect(row?.engagedAgentIds).toEqual([peer.agent.uuid]);
  });

  it("missing agent_chat_sessions row → engagedAgentIds is []", async () => {
    // The leftJoin must tolerate the absence of a row and NOT crash on
    // `state IS NULL`. Freshly created chats start without any
    // agent_chat_sessions rows until the first message is dispatched.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `ea-lazy-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    expect(row?.engagedAgentIds).toEqual([]);
  });

  it("suspended / errored / evicted do NOT count as engaged", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `ea-states-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    for (const state of ["suspended", "errored", "evicted"]) {
      await setSessionState(peer.agent.uuid, chatId, state);
      const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
      expect(row?.engagedAgentIds, `state=${state}`).toEqual([]);
    }

    await setSessionState(peer.agent.uuid, chatId, "active");
    const final = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    expect(final?.engagedAgentIds).toEqual([peer.agent.uuid]);
  });

  it("cross-chat isolation: agent active in chat A does NOT pollute chat B", async () => {
    // This is the core bug #366 took as "acceptable" by hiding the
    // cross-chat false-positive behind `type === 'direct'`. The new
    // derivation is per-(agent, chat) so the false-positive simply
    // doesn't exist.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `ea-iso-${crypto.randomUUID().slice(0, 6)}` });

    const a = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
      topic: "chat-A",
    });
    const b = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
      topic: "chat-B",
    });
    await setSessionState(peer.agent.uuid, a.chatId, "active");
    await setSessionState(peer.agent.uuid, b.chatId, "suspended");

    const rowA = await rowFor(a.chatId, admin.humanAgentUuid, admin.organizationId);
    const rowB = await rowFor(b.chatId, admin.humanAgentUuid, admin.organizationId);
    expect(rowA?.engagedAgentIds).toEqual([peer.agent.uuid]);
    expect(rowB?.engagedAgentIds).toEqual([]);
  });

  it("group chat: every speaker with an active session is included", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `eg-1-${uid}` });
    const { agent: a2 } = await createTestAgent(app, { name: `eg-2-${uid}` });
    const { agent: a3 } = await createTestAgent(app, { name: `eg-3-${uid}` });

    const { chatId } = await createMeChat(app.db, a1.agent.uuid, a1.organizationId, {
      participantIds: [a2.uuid, a3.uuid],
    });

    await setSessionState(a2.uuid, chatId, "active");
    await setSessionState(a3.uuid, chatId, "active");

    const row = await rowFor(chatId, a1.agent.uuid, a1.organizationId);
    expect(row?.engagedAgentIds.sort()).toEqual([a2.uuid, a3.uuid].sort());
  });

  it("watcher rows are excluded — only speakers can appear in engagedAgentIds", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `ea-spk-${crypto.randomUUID().slice(0, 6)}` });
    const watcher = await createTestAgent(app, { name: `ea-w-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await app.db.execute(sql`
      INSERT INTO chat_membership (chat_id, agent_id, role, access_mode, mode, source)
      VALUES (${chatId}, ${watcher.agent.uuid}, 'member', 'watcher', 'full', 'manual')
      ON CONFLICT (chat_id, agent_id) DO NOTHING
    `);

    await setSessionState(peer.agent.uuid, chatId, "suspended");
    await setSessionState(watcher.agent.uuid, chatId, "active");

    const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    expect(row?.engagedAgentIds).toEqual([]);
  });
});

describe("listMeChats: liveActivity derivation from session_events", () => {
  const getApp = useTestApp();

  /**
   * Real client always emits `session:state=active` (which writes the
   * `agent_chat_sessions` row) before emitting any `session:event`. The
   * LATERAL-join derivation reflects that contract — it walks the
   * `(agent_id, chat_id)` directory and looks up each pair's latest
   * event. Tests mirror the wire order: ensureSession then appendEvent.
   */
  async function ensureSession(agentId: string, chatId: string, state = "active"): Promise<void> {
    const app = getApp();
    await app.db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, updated_at)
      VALUES (${agentId}, ${chatId}, ${state}, NOW())
      ON CONFLICT (agent_id, chat_id) DO UPDATE SET state = EXCLUDED.state
    `);
  }

  async function appendEvent(
    agentId: string,
    chatId: string,
    kind: string,
    payload: unknown,
    createdAt?: Date,
  ): Promise<void> {
    const app = getApp();
    await ensureSession(agentId, chatId);
    const id = crypto.randomUUID();
    const ts = createdAt ?? new Date();
    await app.db.execute(sql`
      INSERT INTO session_events (id, agent_id, chat_id, seq, kind, payload, created_at)
      SELECT ${id}, ${agentId}, ${chatId},
             COALESCE(MAX(seq), 0) + 1, ${kind}, ${JSON.stringify(payload)}::jsonb, ${ts.toISOString()}::timestamptz
        FROM session_events
       WHERE agent_id = ${agentId} AND chat_id = ${chatId}
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

  it("null when no session_events recorded for the chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `la-empty-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    expect(row?.liveActivity).toBeNull();
  });

  it("tool_call → label is the tool name", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `la-tool-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await appendEvent(peer.agent.uuid, chatId, "tool_call", {
      toolUseId: "t1",
      name: "Read",
      args: {},
      status: "pending",
    });
    const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    expect(row?.liveActivity).toMatchObject({
      agentId: peer.agent.uuid,
      kind: "tool_call",
      label: "Read",
    });
  });

  it("thinking / assistant_text produce their own labels", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const a = await createTestAgent(app, { name: `la-think-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId: chatA } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [a.agent.uuid],
    });
    await appendEvent(a.agent.uuid, chatA, "thinking", {});
    expect((await rowFor(chatA, admin.humanAgentUuid, admin.organizationId))?.liveActivity?.label).toBe("Thinking");

    const b = await createTestAgent(app, { name: `la-write-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId: chatB } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [b.agent.uuid],
    });
    await appendEvent(b.agent.uuid, chatB, "assistant_text", { text: "hello" });
    expect((await rowFor(chatB, admin.humanAgentUuid, admin.organizationId))?.liveActivity?.label).toBe("Writing");
  });

  it("turn_end as the newest event → null (turn is over)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `la-end-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await appendEvent(peer.agent.uuid, chatId, "tool_call", { toolUseId: "t1", name: "Read", args: {}, status: "ok" });
    await appendEvent(peer.agent.uuid, chatId, "turn_end", { status: "success" });
    const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    expect(row?.liveActivity).toBeNull();
  });

  it("error as the newest event → null (failure surfaced via chat message instead)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `la-err-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    await appendEvent(peer.agent.uuid, chatId, "error", { source: "runtime", message: "boom" });
    const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    expect(row?.liveActivity).toBeNull();
  });

  it("stale event (>60s) is filtered out", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `la-stale-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const oldTs = new Date(Date.now() - 120_000);
    await appendEvent(
      peer.agent.uuid,
      chatId,
      "tool_call",
      { toolUseId: "t1", name: "Read", args: {}, status: "pending" },
      oldTs,
    );
    const row = await rowFor(chatId, admin.humanAgentUuid, admin.organizationId);
    expect(row?.liveActivity).toBeNull();
  });
});

describe("toLiveActivity pure helper", () => {
  const baseRow = { agent_id: "a1", chat_id: "c1", payload: {}, created_at: new Date() };

  it("returns null for terminal kinds", () => {
    expect(toLiveActivity({ ...baseRow, kind: "turn_end" })).toBeNull();
    expect(toLiveActivity({ ...baseRow, kind: "error" })).toBeNull();
    expect(toLiveActivity({ ...baseRow, kind: "unknown_future_kind" })).toBeNull();
  });

  it("uses tool_call payload.name as label, with a fallback", () => {
    expect(
      toLiveActivity({
        ...baseRow,
        kind: "tool_call",
        payload: { toolUseId: "t1", name: "Bash", args: {}, status: "pending" },
      })?.label,
    ).toBe("Bash");
    expect(
      toLiveActivity({
        ...baseRow,
        kind: "tool_call",
        payload: { toolUseId: "t1", name: "", args: {}, status: "pending" },
      })?.label,
    ).toBe("Tool");
    expect(toLiveActivity({ ...baseRow, kind: "tool_call", payload: null })?.label).toBe("Tool");
  });

  it("fixed labels for thinking / assistant_text", () => {
    expect(toLiveActivity({ ...baseRow, kind: "thinking" })?.label).toBe("Thinking");
    expect(toLiveActivity({ ...baseRow, kind: "assistant_text" })?.label).toBe("Writing");
  });

  it("startedAt is the row's createdAt as ISO", () => {
    const ts = new Date("2026-05-14T01:23:45.000Z");
    const a = toLiveActivity({ ...baseRow, kind: "thinking", created_at: ts });
    expect(a?.startedAt).toBe("2026-05-14T01:23:45.000Z");
  });

  it("tool_call carries a `detail` arg preview; thinking/writing have none", () => {
    const bash = toLiveActivity({
      ...baseRow,
      kind: "tool_call",
      payload: { toolUseId: "t1", name: "Bash", args: { command: "npm test" }, status: "pending" },
    });
    expect(bash?.detail).toBe("npm test");
    // No useful args → detail omitted (not empty string).
    expect(
      toLiveActivity({ ...baseRow, kind: "tool_call", payload: { name: "Bash", args: {} } })?.detail,
    ).toBeUndefined();
    expect(toLiveActivity({ ...baseRow, kind: "thinking" })?.detail).toBeUndefined();
  });
});

describe("previewToolArgs", () => {
  it("returns undefined for no/empty args", () => {
    expect(previewToolArgs(undefined)).toBeUndefined();
    expect(previewToolArgs(null)).toBeUndefined();
    expect(previewToolArgs({})).toBeUndefined();
    expect(previewToolArgs("   ")).toBeUndefined();
  });

  it("picks a meaningful field for common tools", () => {
    expect(previewToolArgs({ command: "npm test" })).toBe("npm test");
    expect(previewToolArgs({ file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(previewToolArgs({ query: "needle" })).toBe("needle");
  });

  it("uses a raw string arg directly", () => {
    expect(previewToolArgs("ls -la")).toBe("ls -la");
  });

  it("collapses whitespace and truncates long previews to <=32 chars", () => {
    const out = previewToolArgs({ command: "echo   one    two\nthree   four five six seven eight" });
    expect(out).toBeDefined();
    expect((out as string).length).toBeLessThanOrEqual(32);
    expect(out).toContain("…");
    expect(out).not.toContain("\n");
  });

  it("falls back to JSON for objects without a known field", () => {
    expect(previewToolArgs({ foo: "bar" })).toBe('{"foo":"bar"}');
  });

  it("does NOT treat `description` as an arg value (it's a tool self-description)", () => {
    // `description` is not in the recognised-arg list → JSON fallback, not the
    // raw description string. (Short value so it stays under the truncate cap.)
    expect(previewToolArgs({ description: "hi" })).toBe('{"description":"hi"}');
  });
});
