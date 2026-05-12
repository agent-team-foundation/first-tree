import { describe, expect, it } from "vitest";
import { createChat } from "../services/chat.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Send-to-Agent API", () => {
  const getApp = useTestApp();

  it("sends a message to another agent (auto-creates direct chat)", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "sta-a1" });
    const a2 = await createTestAgent(app, { name: "sta-a2" });

    const res = await a1.request("POST", `/api/v1/agent/agents/${a2.agent.name}/messages`, {
      format: "text",
      content: "Hello agent!",
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    // Server prepends @<targetName> so the recipient always sees the explicit
    // mention regardless of chat type — see agent-send-mention-injection.test.ts.
    expect(msg.content).toBe(`@${a2.agent.name} Hello agent!`);
    expect(msg.chatId).toBeDefined();

    const pollRes = await a2.request("GET", "/api/v1/agent/inbox");
    expect(pollRes.statusCode).toBe(200);
    const entries = pollRes.json();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].message.content).toBe(`@${a2.agent.name} Hello agent!`);
  });

  it("reuses existing direct chat for same pair", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "reuse-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "reuse-a2" });

    const res1 = await a1.request("POST", `/api/v1/agent/agents/${a2.name}/messages`, {
      format: "text",
      content: "First message",
    });
    const chatId1 = res1.json().chatId;

    const res2 = await a1.request("POST", `/api/v1/agent/agents/${a2.name}/messages`, {
      format: "text",
      content: "Second message",
    });
    const chatId2 = res2.json().chatId;

    expect(chatId1).toBe(chatId2);
  });

  it("rejects sending to non-existent agent", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "noagent-a1" });

    const res = await a1.request("POST", "/api/v1/agent/agents/non-existent/messages", {
      format: "text",
      content: "Hello?",
    });
    expect(res.statusCode).toBe(404);
  });

  it("hints at using name when target looks like a uuid (common LLM mistake)", async () => {
    // Agents routinely paste uuids harvested from `agent chats` / participant
    // listings. The 404 error must nudge them to use the name so the next
    // attempt self-corrects rather than looping.
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "uuidhint-a1" });

    const res = await a1.request("POST", "/api/v1/agent/agents/019db446-bdb7-71e6-860c-4204df2db1f6/messages", {
      format: "text",
      content: "Hello?",
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toMatch(/not found/i);
    expect(body.error).toMatch(/name, not a uuid/i);
    expect(body.error).toMatch(/agent list/);
  });

  it("does NOT append the uuid hint when the target is a plain name", async () => {
    // Plain-name 404s are a different failure mode (typo / wrong org) and
    // should not be noised up with uuid guidance.
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "namehint-a1" });

    const res = await a1.request("POST", "/api/v1/agent/agents/typo-target/messages", {
      format: "text",
      content: "Hello?",
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toMatch(/not found/i);
    expect(body.error).not.toMatch(/uuid/i);
  });

  it("sends with replyTo fields", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "reply-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "reply-a2" });

    const res = await a1.request("POST", `/api/v1/agent/agents/${a2.name}/messages`, {
      format: "text",
      content: "Need approval",
      replyToInbox: a1.agent.inboxId,
      // replyToChat must NOT be a real chat where a2 is a participant — that
      // path now triggers current-chat routing (covered separately below).
      // Use a synthetic id so the membership check fails and we exercise the
      // unchanged direct-chat fallback that this test was written for.
      replyToChat: "00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg.replyToInbox).toBe(a1.agent.inboxId);
    expect(msg.replyToChat).toBe("00000000-0000-0000-0000-000000000000");
  });

  // ─── current-chat routing (replyToChat hint) ──────────────────────────
  //
  // When the CLI runs inside an agent sub-process, `resolveReplyToFromEnv`
  // auto-injects `FIRST_TREE_HUB_CHAT_ID` into `replyToChat`. The server uses
  // that as a routing hint: if the recipient is a member of that chat, the
  // message lands there; otherwise it falls back to the pair's direct chat.
  // Three scenarios pinned below — group hit / unrelated chat / direct chat.

  describe("current-chat routing via replyToChat", () => {
    it("lands in the existing chat when target is a participant (group hit)", async () => {
      const app = getApp();
      const sender = await createTestAgent(app, { name: "rtcr-grp-s" });
      const { agent: peer } = await createTestAgent(app, { name: "rtcr-grp-p" });
      const group = await createChat(app.db, sender.agent.uuid, {
        type: "group",
        participantIds: [peer.uuid],
      });

      const res = await sender.request("POST", `/api/v1/agent/agents/${peer.name}/messages`, {
        format: "text",
        content: "in the group",
        replyToChat: group.id,
        replyToInbox: sender.agent.inboxId,
      });
      expect(res.statusCode).toBe(201);
      const msg = res.json();
      expect(msg.chatId).toBe(group.id);
      // Routing already landed in replyToChat — server should strip the
      // envelope so future inbound replies fan out via normal participant
      // rules rather than self-referencing.
      expect(msg.replyToChat).toBeNull();
      expect(msg.replyToInbox).toBeNull();
    });

    it("falls back to direct chat when target is NOT a participant of the current chat", async () => {
      // Group chat (sender + bystander) — recipient `loner` is NOT in it. The
      // hint must NOT cause a misroute into an unrelated chat.
      const app = getApp();
      const sender = await createTestAgent(app, { name: "rtcr-fall-s" });
      const { agent: bystander } = await createTestAgent(app, { name: "rtcr-fall-by" });
      const { agent: loner } = await createTestAgent(app, { name: "rtcr-fall-loner" });
      const unrelated = await createChat(app.db, sender.agent.uuid, {
        type: "group",
        participantIds: [bystander.uuid],
      });

      const res = await sender.request("POST", `/api/v1/agent/agents/${loner.name}/messages`, {
        format: "text",
        content: "private DM",
        replyToChat: unrelated.id,
      });
      expect(res.statusCode).toBe(201);
      const msg = res.json();
      // Lands in the (auto-created) direct chat, not the unrelated group.
      expect(msg.chatId).not.toBe(unrelated.id);
    });

    it("ignores the hint when replyToChat is missing (no env, no flag)", async () => {
      // The bare-script / explicit DM case — original behaviour preserved.
      const app = getApp();
      const sender = await createTestAgent(app, { name: "rtcr-bare-s" });
      const { agent: peer } = await createTestAgent(app, { name: "rtcr-bare-p" });

      const res = await sender.request("POST", `/api/v1/agent/agents/${peer.name}/messages`, {
        format: "text",
        content: "no hint",
      });
      expect(res.statusCode).toBe(201);
      const msg = res.json();
      // Auto-created direct chat — was the only path before this routing
      // change and remains the default when no hint is supplied.
      expect(msg.chatId).toBeDefined();
      expect(msg.content).toBe(`@${peer.name} no hint`);
    });
  });
});
