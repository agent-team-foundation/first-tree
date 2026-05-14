import { describe, expect, it } from "vitest";
import { createChat } from "../services/chat.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Send-to-Agent API", () => {
  const getApp = useTestApp();

  it("sends a message to another agent (opens direct chat with --direct)", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "sta-a1" });
    const a2 = await createTestAgent(app, { name: "sta-a2" });

    // v1 §四 改造 1: opening a side-chat with a non-member requires `direct: true`.
    const res = await a1.request("POST", `/api/v1/agent/agents/${a2.agent.name}/messages`, {
      format: "text",
      content: "Hello agent!",
      direct: true,
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
      direct: true,
    });
    const chatId1 = res1.json().chatId;

    const res2 = await a1.request("POST", `/api/v1/agent/agents/${a2.name}/messages`, {
      format: "text",
      content: "Second message",
      direct: true,
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
    // Agents routinely paste uuids harvested from `chat list` / participant
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
      // explicit --direct path that this test was written for.
      replyToChat: "00000000-0000-0000-0000-000000000000",
      direct: true,
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg.replyToInbox).toBe(a1.agent.inboxId);
    expect(msg.replyToChat).toBe("00000000-0000-0000-0000-000000000000");
  });

  // ─── current-chat routing (replyToChat hint) ──────────────────────────
  //
  // When the CLI runs inside an agent sub-process, `resolveReplyToFromEnv`
  // auto-injects `FIRST_TREE_HUB_CHAT_ID` into `replyToChat`. The server
  // uses that as a routing hint:
  //   - target IS a member of that chat → message lands there.
  //   - target is NOT a member + caller passed `direct: true` → opens or
  //     reuses the pair's direct chat.
  //   - target is NOT a member + no `direct` → server errors with
  //     `AGENT_SEND_NON_MEMBER` (v1 §四 改造 1; #311 fix).

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

    it("non-member target without --direct: errors with AGENT_SEND_NON_MEMBER (v1 §四 改造 1)", async () => {
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
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/--direct/);
    });

    it("non-member target with --direct: opens or reuses the pair's direct chat", async () => {
      const app = getApp();
      const sender = await createTestAgent(app, { name: "rtcr-dir-s" });
      const { agent: bystander } = await createTestAgent(app, { name: "rtcr-dir-by" });
      const { agent: loner } = await createTestAgent(app, { name: "rtcr-dir-loner" });
      const unrelated = await createChat(app.db, sender.agent.uuid, {
        type: "group",
        participantIds: [bystander.uuid],
      });

      const res = await sender.request("POST", `/api/v1/agent/agents/${loner.name}/messages`, {
        format: "text",
        content: "private DM",
        replyToChat: unrelated.id,
        direct: true,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().chatId).not.toBe(unrelated.id);
    });

    it("no hint + no --direct: still errors (implicit DM creation no longer allowed)", async () => {
      const app = getApp();
      const sender = await createTestAgent(app, { name: "rtcr-bare-s" });
      const { agent: peer } = await createTestAgent(app, { name: "rtcr-bare-p" });

      const res = await sender.request("POST", `/api/v1/agent/agents/${peer.name}/messages`, {
        format: "text",
        content: "no hint",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/--direct/);
    });

    it("spoofing guard: non-participant sender cannot drop into a chat they aren't in", async () => {
      // Without the sender-side participant check, this routing branch is a
      // write-anywhere primitive — any agent who knows a chat id and one
      // member's name (both readable from /agent/chats output for chats they
      // ARE in, or guessable in adversarial scenarios) could drop a message
      // into a chat they were never a member of. With v1 §四 改造 1 the
      // spoofer's call errors before any direct chat is created.
      const app = getApp();
      const spoofer = await createTestAgent(app, { name: "rtcr-spoof-s" });
      const insiderA = await createTestAgent(app, { name: "rtcr-spoof-ia" });
      const insiderB = await createTestAgent(app, { name: "rtcr-spoof-ib" });
      const insidersOnly = await createChat(app.db, insiderA.agent.uuid, {
        type: "group",
        participantIds: [insiderB.agent.uuid],
      });

      const res = await spoofer.request("POST", `/api/v1/agent/agents/${insiderB.agent.name}/messages`, {
        format: "text",
        content: "drop into a chat I'm not in",
        replyToChat: insidersOnly.id,
      });
      // Spoofer is not a member of `insidersOnly`, so even with the target
      // membership match the sender-side check refuses the routing branch
      // and falls into the non-member error path.
      expect(res.statusCode).toBe(400);

      // Belt-and-suspenders: confirm nothing from spoofer landed in
      // `insidersOnly` — direct DB read would also work but the inbox path
      // mirrors what real recipients see.
      const inboxA = await insiderA.request("GET", "/api/v1/agent/inbox");
      const entriesA = inboxA.json() as Array<{ message: { chatId: string; senderId: string } }>;
      const leakedToA = entriesA.some(
        (e) => e.message.chatId === insidersOnly.id && e.message.senderId === spoofer.agent.uuid,
      );
      expect(leakedToA).toBe(false);
    });
  });
});
