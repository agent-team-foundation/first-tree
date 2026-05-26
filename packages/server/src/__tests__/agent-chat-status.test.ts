import { randomUUID } from "node:crypto";
import { agentChatStatusSchema, type LiveActivity, RUNTIME_STALE_MS } from "@first-tree/shared";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pendingQuestions } from "../db/schema/pending-questions.js";
import {
  computeErrored,
  computeWorking,
  getChatAgentStatuses,
  isRuntimeFresh,
  resolveAgentChatStatuses,
  withTurnNarration,
} from "../services/agent-chat-status.js";
import { createMeChat } from "../services/me-chat.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("agent-chat-status", () => {
  const getApp = useTestApp();

  async function bindPresence(agentId: string, clientId: string, runtimeState = "idle"): Promise<void> {
    await getApp().db.execute(sql`
      INSERT INTO agent_presence (agent_id, status, client_id, runtime_state, last_seen_at)
      VALUES (${agentId}, 'online', ${clientId}, ${runtimeState}, NOW())
      ON CONFLICT (agent_id) DO UPDATE
        SET status = 'online', client_id = EXCLUDED.client_id, runtime_state = EXCLUDED.runtime_state
    `);
  }

  async function setSession(agentId: string, chatId: string, state: string): Promise<void> {
    await getApp().db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, updated_at)
      VALUES (${agentId}, ${chatId}, ${state}, NOW())
      ON CONFLICT (agent_id, chat_id) DO UPDATE SET state = EXCLUDED.state
    `);
  }

  // Seed `runtime_state` + `runtime_state_at` on the row. `atOffsetMs`
  // shifts the freshness stamp relative to NOW (negative = older); fresh
  // by default. The producer reads these as the per-chat D-axis truth
  // (per #553 rebase: working / errored are no longer derived from
  // `session_events` freshness, they read these columns directly).
  async function setRuntime(agentId: string, chatId: string, runtimeState: string, atOffsetMs = 0): Promise<void> {
    await getApp().db.execute(sql`
      UPDATE agent_chat_sessions
        SET runtime_state = ${runtimeState},
            runtime_state_at = NOW() + (${atOffsetMs}::int * interval '1 millisecond')
        WHERE agent_id = ${agentId} AND chat_id = ${chatId}
    `);
  }

  async function insertEvent(
    agentId: string,
    chatId: string,
    seq: number,
    kind: string,
    payload: unknown,
  ): Promise<void> {
    await getApp().db.execute(sql`
      INSERT INTO session_events (id, agent_id, chat_id, seq, kind, payload, created_at)
      VALUES (${randomUUID()}, ${agentId}, ${chatId}, ${seq}, ${kind}, ${JSON.stringify(payload)}::jsonb, NOW())
    `);
  }

  async function newChatWithAgent() {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `acs-${randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });
    return { app, admin, peer, chatId };
  }

  describe("getChatAgentStatuses (the /agent-status projection)", () => {
    it("folds reachability + active session + pending question into needs_you, and excludes humans", async () => {
      const { app, admin, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await app.db.insert(pendingQuestions).values({
        id: randomUUID(),
        agentId: peer.agent.uuid,
        chatId,
        messageId: randomUUID(),
        status: "pending",
      });

      const statuses = await getChatAgentStatuses(app.db, chatId);
      const s = statuses.find((x) => x.agentId === peer.agent.uuid);
      expect(s?.reachable).toBe(true);
      expect(s?.engagement).toBe("active");
      expect(s?.needsYou).toBe(true);
      expect(s?.main).toBe("needs_you"); // outranks working / ready
      // The human speaker is not a runtime agent — excluded.
      expect(statuses.some((x) => x.agentId === admin.humanAgentUuid)).toBe(false);
    });

    it("a reachable agent with no session reads as ready (not offline)", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.reachable).toBe(true);
      expect(s?.engagement).toBe("none");
      expect(s?.main).toBe("ready");
    });

    it("an unbound agent (no presence row) is offline even with an active session", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await setSession(peer.agent.uuid, chatId, "active");

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.reachable).toBe(false);
      expect(s?.main).toBe("offline"); // reachability gates everything
    });

    it("active session + per-chat runtime=working + fresh tool_call surfaces as working with the activity label", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "working");
      await insertEvent(peer.agent.uuid, chatId, 1, "tool_call", {
        toolUseId: "t1",
        name: "Bash",
        args: null,
        status: "pending",
      });

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.working).toBe(true);
      expect(s?.main).toBe("working");
      expect(s?.activity?.label).toBe("Bash");
    });

    // turnText (folds closed PR #558) — current-turn narration on the /agent-status path.
    it("keeps the current turn's narration on turnText even after a tool_call (sticky)", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "working");
      await insertEvent(peer.agent.uuid, chatId, 1, "assistant_text", { text: "Let me check compose-status-bar.tsx" });
      await insertEvent(peer.agent.uuid, chatId, 2, "tool_call", {
        toolUseId: "t1",
        name: "Read",
        args: { file_path: "x" },
        status: "pending",
      });

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).toBe("working");
      // Base activity stays the tool — sidebar / chat-list keep "Using Read".
      expect(s?.activity?.kind).toBe("tool_call");
      expect(s?.activity?.label).toBe("Read");
      // Compose bar reads the sticky narration off turnText.
      expect(s?.activity?.turnText).toBe("Let me check compose-status-bar.tsx");
    });

    it("does not carry a previous turn's narration into a fresh turn (turnText past turn_end)", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "working");
      await insertEvent(peer.agent.uuid, chatId, 1, "assistant_text", { text: "old turn narration" });
      await insertEvent(peer.agent.uuid, chatId, 2, "turn_end", { status: "success" });
      await insertEvent(peer.agent.uuid, chatId, 3, "tool_call", {
        toolUseId: "t2",
        name: "Bash",
        args: null,
        status: "pending",
      });

      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).toBe("working");
      expect(s?.activity?.kind).toBe("tool_call");
      expect(s?.activity?.turnText).toBeUndefined();
    });

    it("every result satisfies the AgentChatStatus invariant (main === derive(axes))", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId, "error");
      await setSession(peer.agent.uuid, chatId, "active");
      for (const s of await getChatAgentStatuses(app.db, chatId)) {
        expect(() => agentChatStatusSchema.parse(s)).not.toThrow();
      }
    });
  });

  describe("withTurnNarration — sticky narration on the working activity", () => {
    const base: LiveActivity = {
      agentId: "a1",
      kind: "tool_call",
      label: "Bash",
      startedAt: "2026-05-25T00:00:00.000Z",
      detail: "npm test",
    };

    it("returns null when there is no base activity", () => {
      expect(withTurnNarration(null, "anything")).toBeNull();
    });

    it("keeps the base activity unchanged when there is no narration text", () => {
      expect(withTurnNarration(base, null)).toBe(base);
      expect(withTurnNarration(base, "   ")).toBe(base);
    });

    it("attaches a collapsed narration as turnText without touching kind / label / detail", () => {
      const out = withTurnNarration(base, "  Let me   check\nthe file  ");
      expect(out?.kind).toBe("tool_call");
      expect(out?.label).toBe("Bash");
      expect(out?.detail).toBe("npm test");
      expect(out?.turnText).toBe("Let me check the file");
    });
  });

  describe("failed semantics (the errored axis, projected once)", () => {
    it("a reachable agent whose per-chat session is errored reads as failed", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "errored");
      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.errored).toBe(true);
      expect(s?.main).toBe("failed");
    });

    it("a reachable agent whose per-chat runtime is 'error' (fresh, active) reads as failed", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      await setRuntime(peer.agent.uuid, chatId, "error");
      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.errored).toBe(true);
      expect(s?.main).toBe("failed");
    });

    // Reverse #366 regression: agent-global presence.runtime_state='error' must
    // NOT contribute to the per-chat composite errored axis — otherwise an
    // error in chat A would light up every other chat that agent participates
    // in. The per-chat row is the only authority.
    it("agent-global presence.runtime_state='error' does NOT make the composite errored", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId, "error");
      await setSession(peer.agent.uuid, chatId, "active");
      // No per-chat runtime report — runtime_state_at stays NULL (sentinel).
      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.errored).toBe(false);
      expect(s?.main).toBe("ready"); // active session, no working, no error
    });

    it("an unreachable errored agent is offline, not failed (reachability gates)", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await setSession(peer.agent.uuid, chatId, "errored");
      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).toBe("offline");
    });

    it("stale per-chat runtime_state='error' fail-closes (does not surface as errored)", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      // Seed error stamp older than RUNTIME_STALE_MS.
      await setRuntime(peer.agent.uuid, chatId, "error", -(RUNTIME_STALE_MS + 5_000));
      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.errored).toBe(false);
    });

    it("a reachable agent with a healthy active session is not failed", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, chatId, "active");
      const s = (await getChatAgentStatuses(app.db, chatId)).find((x) => x.agentId === peer.agent.uuid);
      expect(s?.main).not.toBe("failed");
    });
  });

  describe("resolveAgentChatStatuses — the one producer", () => {
    it("empty input → empty map", async () => {
      expect((await resolveAgentChatStatuses(getApp().db, [])).size).toBe(0);
    });

    it("union includes a non-speaker agent that has a pending question (not just speakers)", async () => {
      const { app, peer, chatId } = await newChatWithAgent();
      await bindPresence(peer.agent.uuid, peer.clientId);
      // An agent that is NOT a speaker of this chat but has a pending question
      // in it (e.g. it left while a question was outstanding).
      const ghost = await createTestAgent(app, { name: `ghost-${randomUUID().slice(0, 6)}` });
      await app.db.insert(pendingQuestions).values({
        id: randomUUID(),
        agentId: ghost.agent.uuid,
        chatId,
        messageId: randomUUID(),
        status: "pending",
      });

      const all = (await resolveAgentChatStatuses(app.db, [chatId])).get(chatId) ?? [];
      const ghostStatus = all.find((s) => s.agentId === ghost.agent.uuid);
      expect(ghostStatus?.needsYou).toBe(true);
      // …but the /agent-status surface (speakers only) omits it.
      const speakerView = await getChatAgentStatuses(app.db, chatId);
      expect(speakerView.some((s) => s.agentId === ghost.agent.uuid)).toBe(false);
    });

    it("excludes humans from the union (a human speaker never appears)", async () => {
      const { app, admin, chatId } = await newChatWithAgent();
      const all = (await resolveAgentChatStatuses(app.db, [chatId])).get(chatId) ?? [];
      expect(all.some((s) => s.agentId === admin.humanAgentUuid)).toBe(false);
    });

    it("batch isolation: an agent working in chat A does not leak into chat B (#366 defense)", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const peer = await createTestAgent(app, { name: `iso-${randomUUID().slice(0, 6)}` });
      const a = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peer.agent.uuid],
        topic: "A",
      });
      const b = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peer.agent.uuid],
        topic: "B",
      });
      await bindPresence(peer.agent.uuid, peer.clientId);
      // Chat A: active + per-chat runtime=working (this is the per-chat truth
      // the producer reads). The session_events row is description-only.
      await setSession(peer.agent.uuid, a.chatId, "active");
      await setRuntime(peer.agent.uuid, a.chatId, "working");
      await insertEvent(peer.agent.uuid, a.chatId, 1, "tool_call", {
        toolUseId: "t1",
        name: "Bash",
        args: null,
        status: "pending",
      });
      // Chat B: suspended + default runtime_state='idle' / NULL stamp.
      await setSession(peer.agent.uuid, b.chatId, "suspended");

      const byChat = await resolveAgentChatStatuses(app.db, [a.chatId, b.chatId]);
      const inA = byChat.get(a.chatId)?.find((s) => s.agentId === peer.agent.uuid);
      const inB = byChat.get(b.chatId)?.find((s) => s.agentId === peer.agent.uuid);
      expect(inA?.main).toBe("working");
      expect(inB?.working).toBe(false);
      expect(inB?.main).toBe("paused");
    });

    // Per-chat truth: an agent can be working in multiple chats simultaneously
    // without cross-talk. Each chat's row is independent — the producer reads
    // each (agent,chat) pair separately.
    it("single agent working in multiple chats concurrently: each chat reads its own runtime", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const peer = await createTestAgent(app, { name: `multi-${randomUUID().slice(0, 6)}` });
      const a = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peer.agent.uuid],
        topic: "A",
      });
      const b = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peer.agent.uuid],
        topic: "B",
      });
      const c = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peer.agent.uuid],
        topic: "C",
      });
      await bindPresence(peer.agent.uuid, peer.clientId);
      await setSession(peer.agent.uuid, a.chatId, "active");
      await setRuntime(peer.agent.uuid, a.chatId, "working");
      await setSession(peer.agent.uuid, b.chatId, "active");
      await setRuntime(peer.agent.uuid, b.chatId, "working");
      await setSession(peer.agent.uuid, c.chatId, "active");
      await setRuntime(peer.agent.uuid, c.chatId, "idle");

      const byChat = await resolveAgentChatStatuses(app.db, [a.chatId, b.chatId, c.chatId]);
      expect(byChat.get(a.chatId)?.find((s) => s.agentId === peer.agent.uuid)?.main).toBe("working");
      expect(byChat.get(b.chatId)?.find((s) => s.agentId === peer.agent.uuid)?.main).toBe("working");
      expect(byChat.get(c.chatId)?.find((s) => s.agentId === peer.agent.uuid)?.main).toBe("ready");
    });
  });

  // Pure-function helpers — the projection rules in isolation, so the SQL
  // tests above can stay focused on schema/wiring and these can be
  // exhaustive on the truth table.
  describe("isRuntimeFresh / computeWorking / computeErrored — pure projection", () => {
    // Both the captured `now` and the synthetic timestamps reference the
    // same instant — otherwise the "stale by ε" boundary case fails when
    // module-load `now` and call-time `Date.now()` drift across `it`.
    const now = Date.now();
    const recent = (offsetMs: number) => new Date(now + offsetMs);

    it("isRuntimeFresh: false for undefined / suspended / NULL stamp / stale stamp; true for active+fresh", () => {
      expect(isRuntimeFresh(undefined, now)).toBe(false);
      expect(isRuntimeFresh({ state: "suspended", runtimeState: "working", runtimeStateAt: recent(-1000) }, now)).toBe(
        false,
      );
      expect(isRuntimeFresh({ state: "active", runtimeState: "working", runtimeStateAt: null }, now)).toBe(false);
      expect(
        isRuntimeFresh(
          { state: "active", runtimeState: "working", runtimeStateAt: recent(-(RUNTIME_STALE_MS + 1000)) },
          now,
        ),
      ).toBe(false);
      expect(isRuntimeFresh({ state: "active", runtimeState: "working", runtimeStateAt: recent(-1000) }, now)).toBe(
        true,
      );
    });

    it("computeWorking: true only when fresh AND runtime_state==='working'", () => {
      const ok = { state: "active" as const, runtimeState: "working", runtimeStateAt: recent(-1000) };
      expect(computeWorking(ok, now)).toBe(true);
      expect(computeWorking({ ...ok, runtimeState: "idle" }, now)).toBe(false);
      expect(computeWorking({ ...ok, runtimeState: "blocked" }, now)).toBe(false);
      expect(computeWorking({ ...ok, runtimeStateAt: null }, now)).toBe(false);
    });

    it("computeErrored: state='errored' always errored; per-chat runtime='error' errored when fresh+active", () => {
      // C-axis lifecycle errored sticks regardless of D-axis state.
      expect(computeErrored({ state: "errored", runtimeState: "idle", runtimeStateAt: null }, now)).toBe(true);
      // D-axis 'error' only counts when fresh + active.
      expect(computeErrored({ state: "active", runtimeState: "error", runtimeStateAt: recent(-1000) }, now)).toBe(true);
      expect(computeErrored({ state: "active", runtimeState: "error", runtimeStateAt: null }, now)).toBe(false);
      expect(computeErrored({ state: "suspended", runtimeState: "error", runtimeStateAt: recent(-1000) }, now)).toBe(
        false,
      );
    });
  });

  describe("GET /chats/:chatId/agent-status — route auth + shape", () => {
    it("a chat participant gets 200 and an AgentChatStatus[] of non-human speakers", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const peer = await createTestAgent(app, { name: `acs-http-${randomUUID().slice(0, 6)}` });
      const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
        participantIds: [peer.agent.uuid],
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/chats/${chatId}/agent-status`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ agentId: string; main: string }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.find((x) => x.agentId === peer.agent.uuid)).toBeDefined();
      expect(body.some((x) => x.agentId === admin.humanAgentUuid)).toBe(false);
    });

    it("a non-member (different org) gets 404, not the status set", async () => {
      const app = getApp();
      const owner = await createTestAdmin(app);
      const peer = await createTestAgent(app, { name: `acs-http2-${randomUUID().slice(0, 6)}` });
      const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
        participantIds: [peer.agent.uuid],
      });
      const outsider = await createTestAdmin(app);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/chats/${chatId}/agent-status`,
        headers: { authorization: `Bearer ${outsider.accessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
