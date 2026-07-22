import { ASSISTANT_TEXT_PREVIEW_MAX } from "@first-tree/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { previewAssistantText, previewToolArgs, toLiveActivity } from "../services/agent-chat-status.js";
import { createMeChat, listMeChats } from "../services/me-chat.js";
import { createTestAdmin, createTestAgent, TEST_AVATAR_AUTHORITY_TAG, useTestApp } from "./helpers.js";

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
    // Per #553 rebase: liveActivity on the chat-list rides on the
    // composite `working` axis (`activity` is carried only when working).
    // Real clients send `session:runtime working` shortly after a turn
    // begins (the per-chat D-axis truth). Seed `runtime_state='working'`
    // + fresh stamp here so tests that ASSERT a non-null liveActivity
    // model the real wire order; tests that expect null liveActivity
    // (turn_end / stale / quiet) still work because `working` is
    // additionally gated by event freshness via the `activity != null`
    // branch.
    await app.db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, runtime_state, runtime_state_at, updated_at)
      VALUES (${agentId}, ${chatId}, ${state}, 'working', NOW(), NOW())
      ON CONFLICT (agent_id, chat_id) DO UPDATE
        SET state = EXCLUDED.state,
            runtime_state = EXCLUDED.runtime_state,
            runtime_state_at = EXCLUDED.runtime_state_at
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

  async function rowFor(chatId: string, viewerAgentId: string, viewerMemberId: string, organizationId: string) {
    const app = getApp();
    const { rows } = await listMeChats(
      app.db,
      viewerAgentId,
      viewerMemberId,
      organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    return rows.find((r) => r.chatId === chatId) ?? null;
  }

  it("null when no session_events recorded for the chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `la-empty-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    const row = await rowFor(chatId, admin.humanAgentUuid, admin.memberId, admin.organizationId);
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
    const row = await rowFor(chatId, admin.humanAgentUuid, admin.memberId, admin.organizationId);
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
    expect((await rowFor(chatA, admin.humanAgentUuid, admin.memberId, admin.organizationId))?.liveActivity?.label).toBe(
      "Thinking",
    );

    const b = await createTestAgent(app, { name: `la-write-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId: chatB } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [b.agent.uuid],
    });
    await appendEvent(b.agent.uuid, chatB, "assistant_text", { text: "hello" });
    expect((await rowFor(chatB, admin.humanAgentUuid, admin.memberId, admin.organizationId))?.liveActivity?.label).toBe(
      "Writing",
    );
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
    const row = await rowFor(chatId, admin.humanAgentUuid, admin.memberId, admin.organizationId);
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
    const row = await rowFor(chatId, admin.humanAgentUuid, admin.memberId, admin.organizationId);
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
    const row = await rowFor(chatId, admin.humanAgentUuid, admin.memberId, admin.organizationId);
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

  it("tool_call carries a `detail` arg preview; thinking has none", () => {
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

  it("strips codex command shell wrappers from liveActivity detail only for codex command rows", () => {
    const wrapped = "/bin/bash -lc \"sed -n '1,40p' /home/op/context-tree/NODE.md\"";
    expect(
      toLiveActivity({
        ...baseRow,
        kind: "tool_call",
        runtime_provider: "codex",
        payload: { toolUseId: "t1", name: "command", args: { command: wrapped }, status: "pending" },
      })?.detail,
    ).toBe("sed -n '1,40p' /home/op/context…");

    expect(
      toLiveActivity({
        ...baseRow,
        kind: "tool_call",
        runtime_provider: "claude-code",
        payload: { toolUseId: "t1", name: "command", args: { command: wrapped }, status: "pending" },
      })?.detail,
    ).toBe("/bin/bash -lc \"sed -n '1,40p' /…");
  });

  it("assistant_text carries a collapsed reply preview; empty text → none", () => {
    const writing = toLiveActivity({
      ...baseRow,
      kind: "assistant_text",
      payload: { text: "Let me check\n the  schema first" },
    });
    expect(writing?.label).toBe("Writing");
    expect(writing?.detail).toBe("Let me check the schema first");
    // Empty / whitespace-only / missing block → no detail (status bar falls
    // back to the static "Writing").
    expect(toLiveActivity({ ...baseRow, kind: "assistant_text", payload: { text: "   " } })?.detail).toBeUndefined();
    expect(toLiveActivity({ ...baseRow, kind: "assistant_text", payload: {} })?.detail).toBeUndefined();
  });
});

describe("previewAssistantText", () => {
  it("returns undefined for non-string / empty / whitespace-only", () => {
    expect(previewAssistantText(undefined)).toBeUndefined();
    expect(previewAssistantText(null)).toBeUndefined();
    expect(previewAssistantText(123)).toBeUndefined();
    expect(previewAssistantText("")).toBeUndefined();
    expect(previewAssistantText("   \n  ")).toBeUndefined();
  });

  it("collapses whitespace to a single line", () => {
    expect(previewAssistantText("foo   bar\nbaz")).toBe("foo bar baz");
  });

  it("hard-caps to ASSISTANT_TEXT_PREVIEW_MAX chars without an ellipsis", () => {
    const out = previewAssistantText("x".repeat(ASSISTANT_TEXT_PREVIEW_MAX + 50));
    expect(out).toHaveLength(ASSISTANT_TEXT_PREVIEW_MAX);
    expect(out).not.toContain("…");
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
