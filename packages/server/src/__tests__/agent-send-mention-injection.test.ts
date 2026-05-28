import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { messages } from "../db/schema/messages.js";
import { createChat } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Group-chat mention enforcement and content normalisation are core hub
 * routing logic — the agent runtime, web UI, and adapter bridges all depend
 * on the invariants this file pins. Each behavioural axis is covered at the
 * service layer (so failures localise to the rule, not the HTTP layer) plus
 * one HTTP-level integration test per endpoint to guard the wiring.
 *
 * Spec (proposals/group-chat-ux-improvements §3, then refined to two flags):
 *
 *   `enforceGroupMention` — reject group-chat sends where no recipient (other
 *     than the sender) is named, in either `metadata.mentions` or as a
 *     `@<name>` token in the content. Agent + admin paths opt-in; adapters
 *     and webhooks do not.
 *
 *   `normalizeMentionsInContent` — when content is a string, prepend any
 *     `@<name>` tokens that `metadata.mentions` declares but the text omits.
 *     Agent path opts-in; admin/web does not (the picker writes the @
 *     directly; we don't mutate human-typed content).
 *
 * If you tweak step 2b/2c semantics, expect to update this file.
 */

describe("group-chat mention enforcement + content normalisation", () => {
  const getApp = useTestApp();

  /**
   * Build a 3-agent group chat in `group` mode. Returns the sender plus two
   * other agents whose `name` slug is known so tests can write `@<name>`
   * tokens or push uuids into `metadata.mentions` interchangeably.
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

  // ─── Step 2b: enforceGroupMention ──────────────────────────────────────

  describe("step 2b — enforceGroupMention rejects no-recipient group sends", () => {
    it("rejects when neither content nor metadata names a recipient", async () => {
      const app = getApp();
      const { sender, chat } = await setupGroup(crypto.randomUUID().slice(0, 6));
      await expect(
        sendMessage(
          app.db,
          chat.id,
          sender.agent.uuid,
          { source: "api", format: "text", content: "broadcast" },
          { enforceGroupMention: true },
        ),
      ).rejects.toThrow(/no @mention resolved/i);
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
          { enforceGroupMention: true },
        ),
      ).rejects.toThrow(/no @mention resolved/i);
    });

    it("rejects when @token doesn't resolve to any participant", async () => {
      const app = getApp();
      const { sender, chat } = await setupGroup(crypto.randomUUID().slice(0, 6));
      await expect(
        sendMessage(
          app.db,
          chat.id,
          sender.agent.uuid,
          { source: "api", format: "text", content: "@nobody-by-this-name hi" },
          { enforceGroupMention: true },
        ),
      ).rejects.toThrow(/no @mention resolved/i);
    });

    it("rejects when the only @<name> sits inside a fenced code block", async () => {
      // Mirrors the gate-1 behaviour of extractMentions: code-fenced @ tokens
      // do not resolve to a real mention.
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      await expect(
        sendMessage(
          app.db,
          chat.id,
          sender.agent.uuid,
          { source: "api", format: "text", content: `look:\n\`\`\`\n@${peerA.name} in code\n\`\`\`` },
          { enforceGroupMention: true },
        ),
      ).rejects.toThrow(/no @mention resolved/i);
    });

    it("accepts when content has a resolvable @<name>", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: `@${peerA.name} status?` },
        { enforceGroupMention: true },
      );
      expect(result.message).toBeDefined();
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
        { enforceGroupMention: true },
      );
      expect(result.message).toBeDefined();
    });

    it("explicit metadata.mentions overrides content-extracted mentions (explicit-wins)", async () => {
      // When the caller declares `metadata.mentions`, the server trusts
      // that list and skips content `@<name>` extraction so a narrative
      // `@<peer>` in the body can never silently widen the recipient set.
      // To wake both peers, the caller must list both uuids in
      // `metadata.mentions` (or declare via `receiverNames`).
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, peerB, chat } = await setupGroup(uid);
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: `@${peerA.name} ping`, metadata: { mentions: [peerB.uuid] } },
        { enforceGroupMention: true },
      );
      const meta = (result.message.metadata ?? {}) as { mentions?: unknown };
      expect(meta.mentions).toEqual([peerB.uuid]);
    });

    it("does NOT enforce on direct chats even when the flag is on", async () => {
      // Direct chats have a single, unambiguous peer; users routinely send
      // unaddressed text and the routing is still correct.
      const app = getApp();
      const { sender, chat } = await setupDirect(crypto.randomUUID().slice(0, 6));
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "hi" },
        { enforceGroupMention: true },
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

  // ─── Drop-guard regressions ────────────────────────────────────────────
  //
  // PR #614 removed the `Cannot route to "X"` (receiverNames resolution) and
  // `Cannot @-mention "X"` (unresolved-@-token) guards so an agent that names
  // a non-member in prose or in a CLI argument no longer 400s. The misroute
  // is now caught by `enforceGroupMention` for ≥3-speaker chats and absorbed
  // by the 1-on-1 implicit-wake rule for 2-speaker chats. These tests pin
  // the new contract so the relaxation is visible from git blame.

  describe("relaxed routing — unknown names silently drop instead of 400", () => {
    it("1-on-1: `receiverNames` for a non-member lands the message and wakes the lone peer", async () => {
      const app = getApp();
      const { sender, peer, chat } = await setupDirect(crypto.randomUUID().slice(0, 6));
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        {
          source: "api",
          format: "text",
          content: "did this land?",
          receiverNames: ["someone-not-in-this-chat"],
        },
        { enforceGroupMention: true },
      );
      expect(result.message).toBeDefined();
      // Implicit-wake: even though the routing name dropped, the lone other
      // speaker (`peer`) still gets a notify=true inbox row.
      expect(result.recipients).toEqual([peer.inboxId]);
    });

    it("1-on-1: `@<non-member>` in content lands the message and wakes the lone peer", async () => {
      const app = getApp();
      const { sender, peer, chat } = await setupDirect(crypto.randomUUID().slice(0, 6));
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "@stranger heads up" },
        { enforceGroupMention: true },
      );
      expect(result.message).toBeDefined();
      expect(result.recipients).toEqual([peer.inboxId]);
    });

    it("group: `@<non-member>` only — surviving enforceGroupMention guard still 400s", async () => {
      const app = getApp();
      const { sender, chat } = await setupGroup(crypto.randomUUID().slice(0, 6));
      await expect(
        sendMessage(
          app.db,
          chat.id,
          sender.agent.uuid,
          { source: "api", format: "text", content: "@stranger ping" },
          { enforceGroupMention: true },
        ),
      ).rejects.toThrow(/no @mention resolved/i);
    });
  });

  // ─── Step 2c: normalizeMentionsInContent ───────────────────────────────

  describe("step 2c — normalizeMentionsInContent prepends missing @<name>", () => {
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
      // `peerA.name` is e.g. "mt-a-xxxx"; the agent typed it uppercase but it
      // still counts as already-present.
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
      // Defensive: agents are seeded with names today, but if a participant
      // ever lacks one (e.g. mid-rename, soft-deleted) we should silently
      // skip rather than emit `@undefined`.
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, peerB, chat } = await setupGroup(uid);
      // Force peerA's name to null at the DB level.
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
      // `enforceGroupMention` is off so empty-content edge case isn't blocked
      // by the receiver-required check; we're isolating the normalisation step.
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
      // The agent's text only mentions peerA inside a code block, which
      // doesn't count as a real @ — the normaliser should still prepend the
      // missing token from metadata.mentions.
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

  describe("step 2b + 2c together (the agent endpoint configuration)", () => {
    it("rejects bare unaddressed group sends even when normalisation is on", async () => {
      const app = getApp();
      const { sender, chat } = await setupGroup(crypto.randomUUID().slice(0, 6));
      await expect(
        sendMessage(
          app.db,
          chat.id,
          sender.agent.uuid,
          { source: "api", format: "text", content: "hi" },
          { enforceGroupMention: true, normalizeMentionsInContent: true },
        ),
      ).rejects.toThrow(/no @mention resolved/i);
    });

    it("normalises a reply (mentions in metadata, no @ in text) and stores @<name> in DB", async () => {
      // The end-to-end shape of the result-sink reply path: trigger-sender is
      // in metadata.mentions but the agent's text is bare.
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chat } = await setupGroup(uid);
      const result = await sendMessage(
        app.db,
        chat.id,
        sender.agent.uuid,
        { source: "api", format: "text", content: "今天是 2026-04-27。", metadata: { mentions: [peerA.uuid] } },
        { enforceGroupMention: true, normalizeMentionsInContent: true },
      );
      expect(result.message.content).toBe(`@${peerA.name} 今天是 2026-04-27。`);

      // Persisted row also reflects normalised content + merged mentions.
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

    it("rejects no-mention group sends with 400", async () => {
      const { sender, chatId } = await setupViaApi(crypto.randomUUID().slice(0, 6));
      const res = await sender.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
        format: "text",
        content: "everyone, status?",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/no @mention resolved/i);
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

    it("accepts content with explicit @<name> verbatim", async () => {
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chatId } = await setupViaApi(uid);
      const res = await sender.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
        format: "text",
        content: `@${peerA.agent.name} status?`,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().content).toBe(`@${peerA.agent.name} status?`);
    });
  });

  // ─── Integration: admin endpoint (POST /admin/chats/:id/messages) ──────

  describe("integration — admin endpoint POST /admin/chats/:id/messages", () => {
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

    it("rejects bypass attempts (no @ + no metadata.mentions) with 400", async () => {
      const { sender, chatId } = await setupViaApi(crypto.randomUUID().slice(0, 6));
      const res = await sender.request("POST", `/api/v1/chats/${chatId}/messages`, {
        format: "text",
        content: "broadcast — no @",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/no @mention resolved/i);
    });

    it("does NOT normalise content even when metadata.mentions is provided", async () => {
      // Web users typed exactly what they typed; the picker is responsible for
      // inserting @ tokens. Server must not silently rewrite human-typed text.
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

    it("accepts a real picker-style send (content already has @<name>)", async () => {
      const uid = crypto.randomUUID().slice(0, 6);
      const { sender, peerA, chatId } = await setupViaApi(uid);
      const res = await sender.request("POST", `/api/v1/chats/${chatId}/messages`, {
        format: "text",
        content: `@${peerA.agent.name} how's it going?`,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().content).toBe(`@${peerA.agent.name} how's it going?`);
    });
  });

  // sendToAgent is gone — the by-name routing primitive has been retired
  // (see first-tree-context PR #281). CLI `chat send <name>` now goes
  // through `POST /api/v1/agent/chats/:chatId/messages` with the
  // recipient name declared in `receiverNames`. Mention injection on the
  // sendMessage path is exercised by the group/direct-chat suites above.

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
        { enforceGroupMention: true, normalizeMentionsInContent: true },
      );
      const [row] = await app.db.select().from(messages).where(eq(messages.id, result.message.id)).limit(1);
      if (!row) throw new Error("message row missing");
      expect(row.content).toBe(result.message.content);
      const meta = (row.metadata ?? {}) as { mentions?: unknown };
      expect(meta.mentions).toEqual([peerA.uuid]);
    });

    it("rejected sends do not persist a row", async () => {
      // 400 on enforce must roll back the transaction — no half-written
      // message, no orphan inbox entries.
      const app = getApp();
      const { sender, chat } = await setupGroup(crypto.randomUUID().slice(0, 6));
      const beforeCount = await app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chat.id));
      await expect(
        sendMessage(
          app.db,
          chat.id,
          sender.agent.uuid,
          { source: "api", format: "text", content: "broadcast" },
          { enforceGroupMention: true },
        ),
      ).rejects.toThrow();
      const afterCount = await app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chat.id));
      expect(afterCount.length).toBe(beforeCount.length);
    });
  });
});
