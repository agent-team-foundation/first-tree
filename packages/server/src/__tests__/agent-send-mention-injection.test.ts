import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { messages } from "../db/schema/messages.js";
import { createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Mention enforcement + content normalisation are core server routing
 * logic. The agent runtime, web UI, and adapter bridges all depend on
 * the invariants this file pins. Each behavioural axis is covered at
 * the service layer (so failures localise to the rule, not the HTTP
 * layer) plus one HTTP-level integration test per endpoint to guard the
 * wiring.
 *
 * Spec (post-retire of content extraction — see services/message.ts
 * "Routing contract"):
 *
 *   `enforceMention` — reject sends where no recipient (other than the
 *     sender) is declared via `metadata.mentions` (uuids),
 *     `receiverNames` (names, resolved by the server), or
 *     `addressedToAgentIds` (system-routed). The web and agent SDK
 *     endpoints opt-in; adapters and webhooks do not.
 *     `purpose: "agent-final-text"` bypasses the check unconditionally.
 *     The server NEVER parses `@<name>` tokens out of content — clients
 *     must resolve mentions themselves and declare routing explicitly.
 *
 *   `normalizeMentionsInContent` — when content is a string, prepend
 *     any `@<name>` tokens that `metadata.mentions` declares but the
 *     text omits. Agent endpoint opts in; web does not (the composer
 *     writes the @ directly; we don't mutate human-typed content).
 *
 * If you tweak the enforce / normalise semantics, expect to update this file.
 */

describe("mention enforcement + content normalisation", () => {
  const getApp = useTestApp();

  /**
   * Build a 3-agent group chat. Returns the sender plus two other
   * agents whose `name` slug is known so tests can push uuids into
   * `metadata.mentions` and assert the rendered `@<name>` content.
   */
  async function setupGroup(uid: string) {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `mt-s-${uid}` });
    const { agent: peerA } = await createTestAgent(app, { name: `mt-a-${uid}` });
    const { agent: peerB } = await createTestAgent(app, { name: `mt-b-${uid}` });
    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [peerA.uuid, peerB.uuid],
    });
    return { sender, peerA, peerB, chat };
  }

  async function setupDirect(uid: string) {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `dt-s-${uid}` });
    const { agent: peer } = await createTestAgent(app, { name: `dt-p-${uid}` });
    const chat = await createChat(app.db, sender.agent.uuid, {
      type: "group",
      participantIds: [peer.uuid],
    });
    return { sender, peer, chat };
  }

  // ─── enforceMention ────────────────────────────────────────────────────

  describe("enforceMention rejects sends with no declared recipient", () => {
    it("rejects when no routing is declared at all", async () => {
      const app = getApp();
      const { sender, chat } = await setupGroup(crypto.randomUUID().slice(0, 6));
      await expect(
        sendMessage(
          app.db,
          chat.id,
          sender.agent.uuid,
          { source: "api", format: "text", content: "broadcast" },
          { enforceMention: true },
        ),
      ).rejects.toThrow(/explicit recipient/i);
    });

    it("rejects when only the sender is named (self-mention doesn't count)", async () => {
      const app = getApp();
      const { sender, chat } = await setupGroup(crypto.randomUUID().slice(0, 6));
      await expect(
        sendMessage(
          app.db,
          chat.id,
          sender.agent.uuid,
          { source: "api", format: "text", content: "talking to myself", metadata: { mentions: [sender.agent.uuid] } },
          { enforceMention: true },
        ),
      ).rejects.toThrow(/explicit recipient/i);
    });

    it("rejects when content contains an `@<name>` token but no explicit mentions are declared", async () => {
      // Regression guard for the explicit-only contract: the server no
      // longer parses content. An `@<peer>` written by a human or agent
      // without a companion `metadata.mentions` / `receiverNames` is
      // narrative text, not a wake-up declaration.
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      await expect(
        sendMessage(
          app.db,
          chat.id,
          sender.agent.uuid,
          { source: "api", format: "text", content: `@${peerA.name} status?` },
          { enforceMention: true },
        ),
      ).rejects.toThrow(/explicit recipient/i);
    });

    it("accepts when metadata.mentions names a non-sender participant", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "ping", metadata: { mentions: [peerA.uuid] } },
        { enforceMention: true },
      );
      expect(result.message).toBeDefined();
    });

    it("accepts when receiverNames names a participant (server resolves to uuid)", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      if (!peerA.name) throw new Error("peerA name missing");
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "ping", receiverNames: [peerA.name] },
        { enforceMention: true },
      );
      expect(result.message).toBeDefined();
      const meta = (result.message.metadata ?? {}) as { mentions?: unknown };
      expect(meta.mentions).toEqual([peerA.uuid]);
    });

    it("accepts when addressedToAgentIds declares a system-routed recipient (no metadata required)", async () => {
      // github-delivery's shape: no metadata.mentions, but
      // addressedToAgentIds is the routing declaration.
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "system event" },
        { enforceMention: true, addressedToAgentIds: [peerA.uuid] },
      );
      expect(result.message).toBeDefined();
    });

    it("explicit metadata.mentions is the single source of truth (content @<name> ignored)", async () => {
      // The server treats `@<peer>` in content as narrative text. Only
      // declared mentions land in `message.metadata.mentions` — even
      // when content names a different peer entirely.
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, peerB, chat } = await setupGroup(uid);
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: `@${peerA.name} ping`, metadata: { mentions: [peerB.uuid] } },
        { enforceMention: true },
      );
      const meta = (result.message.metadata ?? {}) as { mentions?: unknown };
      expect(meta.mentions).toEqual([peerB.uuid]);
    });

    it("enforces on direct (2-speaker) chats too — the legacy 1:1 implicit-wake bypass is gone", async () => {
      // The previous `enforceGroupMention` skipped 2-speaker chats and
      // the fan-out auto-woke the peer. Under the explicit-only
      // contract, web clients are expected to inject the peer's uuid
      // into `metadata.mentions` for 1:1 chats; a bare send without
      // mentions is now a 400.
      const app = getApp();
      const { sender, chat } = await setupDirect(crypto.randomUUID().slice(0, 6));
      await expect(
        sendMessage(
          app.db,
          chat.id,
          sender.agent.uuid,
          { source: "api", format: "text", content: "hi" },
          { enforceMention: true },
        ),
      ).rejects.toThrow(/explicit recipient/i);
    });

    it("accepts a 1:1 send when the peer is declared in metadata.mentions (web composer pattern)", async () => {
      const app = getApp();
      const { sender, peer, chat } = await setupDirect(crypto.randomUUID().slice(0, 6));
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "hi", metadata: { mentions: [peer.uuid] } },
        { enforceMention: true },
      );
      expect(result.message).toBeDefined();
    });

    it("does NOT enforce when the flag is off (adapters / webhooks / system tasks)", async () => {
      const app = getApp();
      const { sender, chat } = await setupGroup(crypto.randomUUID().slice(0, 6));
      const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
        source: "api",
        format: "text",
        content: "system broadcast",
      });
      expect(result.message).toBeDefined();
    });
  });

  // ─── normalizeMentionsInContent ────────────────────────────────────────

  describe("normalizeMentionsInContent prepends missing @<name>", () => {
    it("prepends @<name> when metadata.mentions has someone the text doesn't address", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "今天是 2026-04-27。", metadata: { mentions: [peerA.uuid] } },
        { normalizeMentionsInContent: true },
      );
      expect(result.message.content).toBe(`@${peerA.name} 今天是 2026-04-27。`);
    });

    it("is idempotent when the agent already wrote @<name>", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: `@${peerA.name} got it`, metadata: { mentions: [peerA.uuid] } },
        { normalizeMentionsInContent: true },
      );
      expect(result.message.content).toBe(`@${peerA.name} got it`);
    });

    it("treats existing tokens case-insensitively (no double-stamp)", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const upper = peerA.name?.toUpperCase();
      if (!upper) throw new Error("peerA name missing");
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: `@${upper} got it`, metadata: { mentions: [peerA.uuid] } },
        { normalizeMentionsInContent: true },
      );
      expect(result.message.content).toBe(`@${upper} got it`);
    });

    it("prepends multiple missing names in stable order (matches mergedMentions order)", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, peerB, chat } = await setupGroup(uid);
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "done", metadata: { mentions: [peerA.uuid, peerB.uuid] } },
        { normalizeMentionsInContent: true },
      );
      expect(result.message.content).toBe(`@${peerA.name} @${peerB.name} done`);
    });

    it("only prepends the missing names when one is already present (partial)", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, peerB, chat } = await setupGroup(uid);
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        {
          source: "api",
          format: "text",
          content: `@${peerA.name} done`,
          metadata: { mentions: [peerA.uuid, peerB.uuid] },
        },
        { normalizeMentionsInContent: true },
      );
      expect(result.message.content).toBe(`@${peerB.name} @${peerA.name} done`);
    });

    it("skips the sender even if they're in the merged-mention list", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "ok", metadata: { mentions: [sender.agent.uuid, peerA.uuid] } },
        { normalizeMentionsInContent: true },
      );
      expect(result.message.content).toBe(`@${peerA.name} ok`);
    });

    it("ignores mentions whose participant has no `name` slug", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, peerB, chat } = await setupGroup(uid);
      await app.db.update(agents).set({ name: null }).where(eq(agents.uuid, peerA.uuid));
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "hi", metadata: { mentions: [peerA.uuid, peerB.uuid] } },
        { normalizeMentionsInContent: true },
      );
      expect(result.message.content).toBe(`@${peerB.name} hi`);
    });

    it("ignores mentions that don't resolve to any chat participant", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const ghostUuid = "00000000-0000-0000-0000-000000000000";
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "report", metadata: { mentions: [ghostUuid, peerA.uuid] } },
        { normalizeMentionsInContent: true },
      );
      expect(result.message.content).toBe(`@${peerA.name} report`);
    });

    it("emits just the prefix when content is the empty string", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "", metadata: { mentions: [peerA.uuid] } },
        { normalizeMentionsInContent: true },
      );
      expect(result.message.content).toBe(`@${peerA.name}`);
    });

    it("leaves non-string content untouched (cards, files, structured payloads)", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const card = { kind: "card", title: "approval needed" };
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "card", content: card, metadata: { mentions: [peerA.uuid] } },
        { normalizeMentionsInContent: true },
      );
      expect(result.message.content).toEqual(card);
    });

    it("does NOT mutate content when the flag is off", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const result = await sendMessage(app.db, chat.id, sender.agent.uuid, {
        source: "api",
        format: "text",
        content: "verbatim please",
        metadata: { mentions: [peerA.uuid] },
      });
      expect(result.message.content).toBe("verbatim please");
    });

    it("ignores @<name> tokens hidden in code fences (still prepends real ones)", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const codeBody = `\`\`\`\n@${peerA.name} ignored\n\`\`\``;
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: codeBody, metadata: { mentions: [peerA.uuid] } },
        { normalizeMentionsInContent: true },
      );
      expect(result.message.content).toBe(`@${peerA.name} ${codeBody}`);
    });
  });

  // ─── Combined: enforce + normalise on the same call ────────────────────

  describe("enforceMention + normalizeMentionsInContent together (the agent endpoint configuration)", () => {
    it("rejects unaddressed sends even when normalisation is on", async () => {
      const app = getApp();
      const { sender, chat } = await setupGroup(crypto.randomUUID().slice(0, 6));
      await expect(
        sendMessage(
          app.db,
          chat.id,
          sender.agent.uuid,
          { source: "api", format: "text", content: "hi" },
          { enforceMention: true, normalizeMentionsInContent: true },
        ),
      ).rejects.toThrow(/explicit recipient/i);
    });

    it("normalises a reply (mentions in metadata, no @ in text) and stores @<name> in DB", async () => {
      // result-sink reply shape: trigger-sender is in metadata.mentions
      // but the agent's text is bare.
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "今天是 2026-04-27。", metadata: { mentions: [peerA.uuid] } },
        { enforceMention: true, normalizeMentionsInContent: true },
      );
      expect(result.message.content).toBe(`@${peerA.name} 今天是 2026-04-27。`);

      const [row] = await app.db.select().from(messages).where(eq(messages.id, result.message.id)).limit(1);
      if (!row) throw new Error("message row missing");
      expect(row.content).toBe(`@${peerA.name} 今天是 2026-04-27。`);
      const meta = (row.metadata ?? {}) as { mentions?: unknown };
      expect(meta.mentions).toEqual([peerA.uuid]);
    });
  });

  // ─── Integration: agent endpoint (POST /agent/chats/:id/messages) ──────

  describe("integration — agent endpoint POST /agent/chats/:id/messages", () => {
    async function setupViaApi(uid: string) {
      const app = getApp();
      const sender = await createTestAgent(app, { name: `int-s-${uid}` });
      const peerA = await createTestAgent(app, { name: `int-a-${uid}` });
      const peerB = await createTestAgent(app, { name: `int-b-${uid}` });
      const chatRes = await sender.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [peerA.agent.uuid, peerB.agent.uuid],
      });
      expect(chatRes.statusCode).toBe(201);
      return { sender, peerA, peerB, chatId: chatRes.json().id as string };
    }

    it("rejects no-mention sends with 400", async () => {
      const { sender, chatId } = await setupViaApi(crypto.randomUUID().slice(0, 6));
      const res = await sender.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
        format: "text",
        content: "everyone, status?",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/explicit recipient/i);
    });

    it("normalises reply content (mentions in metadata, no @ in text)", async () => {
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chatId } = await setupViaApi(uid);
      const res = await sender.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
        format: "text",
        content: "done",
        metadata: { mentions: [peerA.agent.uuid] },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().content).toBe(`@${peerA.agent.name} done`);
    });

    it("accepts content with explicit @<name> when mentions are also declared", async () => {
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chatId } = await setupViaApi(uid);
      const res = await sender.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
        format: "text",
        content: `@${peerA.agent.name} status?`,
        metadata: { mentions: [peerA.agent.uuid] },
      });
      expect(res.statusCode).toBe(201);
      // normalize is idempotent: the @<name> is already present.
      expect(res.json().content).toBe(`@${peerA.agent.name} status?`);
    });
  });

  // ─── Integration: web endpoint (POST /chats/:id/messages) ──────────────

  describe("integration — web endpoint POST /chats/:id/messages", () => {
    async function setupViaApi(uid: string) {
      const app = getApp();
      const sender = await createTestAgent(app, { name: `adm-s-${uid}` });
      const peerA = await createTestAgent(app, { name: `adm-a-${uid}` });
      const peerB = await createTestAgent(app, { name: `adm-b-${uid}` });
      const chatRes = await sender.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [peerA.agent.uuid, peerB.agent.uuid],
      });
      expect(chatRes.statusCode).toBe(201);
      return { sender, peerA, peerB, chatId: chatRes.json().id as string };
    }

    it("rejects bypass attempts (no mentions declared) with 400", async () => {
      const { sender, chatId } = await setupViaApi(crypto.randomUUID().slice(0, 6));
      const res = await sender.request("POST", `/api/v1/chats/${chatId}/messages`, {
        format: "text",
        content: "broadcast — no @",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/explicit recipient/i);
    });

    it("does NOT normalise content even when metadata.mentions is provided", async () => {
      // Web users typed exactly what they typed; the composer is responsible
      // for inserting @ tokens. Server must not silently rewrite human-typed
      // text.
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chatId } = await setupViaApi(uid);
      const res = await sender.request("POST", `/api/v1/chats/${chatId}/messages`, {
        format: "text",
        content: "team status update",
        metadata: { mentions: [peerA.agent.uuid] },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().content).toBe("team status update");
    });

    it("accepts a real picker-style send (content already has @<name>, mentions declared)", async () => {
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chatId } = await setupViaApi(uid);
      const res = await sender.request("POST", `/api/v1/chats/${chatId}/messages`, {
        format: "text",
        content: `@${peerA.agent.name} how's it going?`,
        metadata: { mentions: [peerA.agent.uuid] },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().content).toBe(`@${peerA.agent.name} how's it going?`);
    });
  });

  // ─── Cross-cutting: persisted state matches API response ───────────────

  describe("persisted state matches the API response", () => {
    it("DB row content mirrors the normalised content returned to the caller", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "ok", metadata: { mentions: [peerA.uuid] } },
        { enforceMention: true, normalizeMentionsInContent: true },
      );
      const [row] = await app.db.select().from(messages).where(eq(messages.id, result.message.id)).limit(1);
      if (!row) throw new Error("message row missing");
      expect(row.content).toBe(result.message.content);
      const meta = (row.metadata ?? {}) as { mentions?: unknown };
      expect(meta.mentions).toEqual([peerA.uuid]);
    });

    it("rejected sends do not persist a row", async () => {
      const app = getApp();
      const { sender, chat } = await setupGroup(crypto.randomUUID().slice(0, 6));
      const beforeCount = await app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chat.id));
      await expect(
        sendMessage(
          app.db,
          chat.id,
          sender.agent.uuid,
          { source: "api", format: "text", content: "broadcast" },
          { enforceMention: true },
        ),
      ).rejects.toThrow();
      const afterCount = await app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chat.id));
      expect(afterCount.length).toBe(beforeCount.length);
    });
  });
});
