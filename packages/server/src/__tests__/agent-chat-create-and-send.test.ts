import { AGENT_VISIBILITY } from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { createAgent } from "../services/agent.js";
import { agentRequest, createAdminContext, createTestAgent, useTestApp } from "./helpers.js";

async function tableCount(app: ReturnType<ReturnType<typeof useTestApp>>, table: typeof chats | typeof messages) {
  const [row] = await app.db.select({ count: sql<number>`count(*)::int` }).from(table);
  return row?.count ?? 0;
}

describe("Agent chat create-and-send API", () => {
  const getApp = useTestApp();

  it("creates a chat, then sends the first message with --to recipients and --with context-only participants", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: "create-sender" });
    const to = await createTestAgent(app, { name: "create-to" });
    const withTarget = await createTestAgent(app, { name: "create-with" });

    const res = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-create-1",
      to: [to.agent.name],
      with: [withTarget.agent.name],
      message: { format: "text", content: "Please start", source: "cli" },
      topic: "Task chat",
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.replayed).toBe(false);
    expect(body.senderAgentId).toBe(sender.agent.uuid);
    expect(body.recipientAgentIds).toEqual([to.agent.uuid]);
    expect(body.participantAgentIds.sort()).toEqual([sender.agent.uuid, to.agent.uuid, withTarget.agent.uuid].sort());

    const [message] = await app.db.select().from(messages).where(eq(messages.id, body.message.id)).limit(1);
    expect(message?.source).toBe("cli");
    expect(message?.metadata.mentions).toEqual([to.agent.uuid]);
    expect(message?.content).toBe(`@${to.agent.name} Please start`);

    const fanout = await app.db
      .select({ inboxId: inboxEntries.inboxId, notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.chatId, body.chat.id), eq(inboxEntries.messageId, body.message.id)));
    expect(fanout).toEqual(
      expect.arrayContaining([
        { inboxId: to.agent.inboxId, notify: true },
        { inboxId: withTarget.agent.inboxId, notify: false },
      ]),
    );

    const sessionRows = await app.db
      .select({ agentId: agentChatSessions.agentId, state: agentChatSessions.state })
      .from(agentChatSessions)
      .where(eq(agentChatSessions.chatId, body.chat.id));
    expect(sessionRows).toEqual([{ agentId: to.agent.uuid, state: "active" }]);

    const memberships = await app.db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(eq(chatMembership.chatId, body.chat.id));
    expect(memberships.map((row) => row.agentId)).toEqual(
      expect.arrayContaining([sender.agent.uuid, to.agent.uuid, withTarget.agent.uuid]),
    );
  });

  it("defaults SDK/API message source to api when omitted", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: "api-source-sender" });
    const target = await createTestAgent(app, { name: "api-source-target" });

    const res = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-source-default",
      to: [`id:${target.agent.uuid}`],
      message: { format: "text", content: "API sourced" },
    });

    expect(res.statusCode).toBe(201);
    const [message] = await app.db.select().from(messages).where(eq(messages.id, res.json().message.id)).limit(1);
    expect(message?.source).toBe("api");
  });

  it("rejects create-and-send message sources outside cli/api", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: "source-limit-sender" });
    const target = await createTestAgent(app, { name: "source-limit-target" });
    const initialChatCount = await tableCount(app, chats);
    const initialMessageCount = await tableCount(app, messages);

    for (const source of ["web", "github"] as const) {
      const res = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
        operationId: `op-source-${source}`,
        to: [target.agent.name],
        message: { format: "text", content: "wrong source", source },
      });

      expect(res.statusCode).toBe(400);
    }
    expect(await tableCount(app, chats)).toBe(initialChatCount);
    expect(await tableCount(app, messages)).toBe(initialMessageCount);
  });

  it("replays the same sender operation without duplicating chat or message", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: "idem-sender" });
    const target = await createTestAgent(app, { name: "idem-target" });
    const notifySpy = vi.spyOn(app.notifier, "notify");
    const payload = {
      operationId: "op-idem",
      to: [target.agent.name],
      message: { format: "text", content: "Do it", source: "cli" },
    };

    const first = await sender.request("POST", "/api/v1/agent/chats/create-and-send", payload);
    try {
      expect(first.statusCode).toBe(201);
      const firstBody = first.json();
      expect(notifySpy).toHaveBeenCalledTimes(1);
      await app.db
        .update(agentChatSessions)
        .set({ state: "suspended" })
        .where(and(eq(agentChatSessions.agentId, target.agent.uuid), eq(agentChatSessions.chatId, firstBody.chat.id)));
      notifySpy.mockClear();

      const replay = await sender.request("POST", "/api/v1/agent/chats/create-and-send", payload);

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({
        chat: firstBody.chat,
        message: firstBody.message,
        operationId: "op-idem",
        replayed: true,
      });
      expect(await tableCount(app, chats)).toBe(1);
      expect(await tableCount(app, messages)).toBe(1);
      expect(notifySpy).not.toHaveBeenCalled();
      const [session] = await app.db
        .select({ state: agentChatSessions.state })
        .from(agentChatSessions)
        .where(and(eq(agentChatSessions.agentId, target.agent.uuid), eq(agentChatSessions.chatId, firstBody.chat.id)))
        .limit(1);
      expect(session?.state).toBe("suspended");
    } finally {
      notifySpy.mockRestore();
    }
  });

  it("rejects operation id reuse with a different request body", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: "reuse-sender" });
    const target = await createTestAgent(app, { name: "reuse-target" });

    const first = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-reuse",
      to: [target.agent.name],
      message: { format: "text", content: "one" },
    });
    expect(first.statusCode).toBe(201);

    const second = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-reuse",
      to: [target.agent.name],
      message: { format: "text", content: "two" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("CHAT_CREATE_IDEMPOTENCY_KEY_REUSED");
    expect(await tableCount(app, chats)).toBe(1);
    expect(await tableCount(app, messages)).toBe(1);
  });

  it("does not retain the operation id after a failed create attempt", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: "retry-fail-sender" });
    const target = await createTestAgent(app, { name: "retry-fail-target" });
    const payload = {
      operationId: "op-retry-after-failure",
      to: [target.agent.name],
      message: { format: "text", content: "" },
    };

    const failed = await sender.request("POST", "/api/v1/agent/chats/create-and-send", payload);
    expect(failed.statusCode).toBe(400);

    const retried = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      ...payload,
      message: { format: "text", content: "fixed" },
    });
    expect(retried.statusCode).toBe(201);
  });

  it("resolves raw, id:, and name: selectors and rejects ambiguous raw selectors", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: "selector-sender" });
    const byId = await createTestAgent(app, { name: "selector-by-id" });
    const byName = await createTestAgent(app, { name: "selector-by-name" });
    const uuidShapedName = await createTestAgent(app, { name: byId.agent.uuid });

    const byNameRes = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-name",
      to: [`name:${byName.agent.name}`],
      message: { format: "text", content: "name target" },
    });
    expect(byNameRes.statusCode).toBe(201);

    const byIdRes = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-id",
      to: [`id:${byId.agent.uuid}`],
      message: { format: "text", content: "id target" },
    });
    expect(byIdRes.statusCode).toBe(201);

    const ambiguous = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-ambiguous",
      to: [byId.agent.uuid],
      message: { format: "text", content: "ambiguous" },
    });
    expect(ambiguous.statusCode).toBe(400);
    expect(ambiguous.json()).toMatchObject({
      code: "CHAT_CREATE_SELECTOR_AMBIGUOUS",
      details: { option: "--to", input: byId.agent.uuid },
    });
    expect(uuidShapedName.agent.name).toBe(byId.agent.uuid);
  });

  it("rejects duplicate targets, self targets, inactive targets, and private targets outside the sender manager", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: "reject-sender" });
    const target = await createTestAgent(app, { name: "reject-target" });
    const suspended = await createTestAgent(app, { name: "reject-suspended" });
    const privateTarget = await createTestAgent(app, { name: "reject-private" });
    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, suspended.agent.uuid));
    await app.db
      .update(agents)
      .set({ visibility: AGENT_VISIBILITY.PRIVATE })
      .where(eq(agents.uuid, privateTarget.agent.uuid));

    const duplicate = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-dup",
      to: [target.agent.name],
      with: [`id:${target.agent.uuid}`],
      message: { format: "text", content: "dup" },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().code).toBe("CHAT_CREATE_DUPLICATE_TARGET");

    const self = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-self",
      to: [sender.agent.name],
      message: { format: "text", content: "self" },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().code).toBe("CHAT_CREATE_SELF_TARGET");

    const inactive = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-inactive",
      to: [suspended.agent.name],
      message: { format: "text", content: "inactive" },
    });
    expect(inactive.statusCode).toBe(400);
    expect(inactive.json().code).toBe("CHAT_CREATE_TARGET_INACTIVE");

    const privateRes = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-private",
      to: [privateTarget.agent.name],
      message: { format: "text", content: "private" },
    });
    expect(privateRes.statusCode).toBe(403);
    expect(privateRes.json().code).toBe("CHAT_CREATE_TARGET_NOT_VISIBLE");
  });

  it("allows same-manager private targets", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: "same-private-admin" });
    const senderAgent = await createAgent(app.db, {
      name: "same-private-sender",
      type: "agent",
      displayName: "Same Private Sender",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const privateTarget = await createAgent(app.db, {
      name: "same-private-target",
      type: "agent",
      displayName: "Same Private Target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    await app.db
      .update(agents)
      .set({ visibility: AGENT_VISIBILITY.PRIVATE })
      .where(eq(agents.uuid, privateTarget.uuid));
    const request = agentRequest(app, admin.accessToken, senderAgent.uuid);
    if (!privateTarget.name) throw new Error("private target name missing");

    const res = await request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-same-private",
      to: [privateTarget.name],
      message: { format: "text", content: "same manager" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().recipientAgentIds).toEqual([privateTarget.uuid]);
  });

  it("does not leave an empty chat when validation fails before chat creation", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: "partial-sender" });

    const res = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-partial",
      to: ["missing-target"],
      message: { format: "text", content: "will fail" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("CHAT_CREATE_TARGET_NOT_FOUND");
    expect(await tableCount(app, chats)).toBe(0);
    expect(await tableCount(app, messages)).toBe(0);
  });

  it("returns a structured partial-failure error if the initial message send fails after chat creation", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: "message-fail-sender" });
    const target = await createTestAgent(app, { name: "message-fail-target" });

    const res = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-message-fails",
      to: [target.agent.name],
      message: {
        format: "text",
        content: "will fail during send",
        metadata: {
          documentContext: {
            kind: "snapshot",
            docs: [
              {
                path: "docs/example.md",
                content: "hello",
                size: 5,
                sha256: "0".repeat(64),
              },
            ],
          },
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "CHAT_CREATE_INITIAL_MESSAGE_FAILED",
      details: {
        operationId: "op-message-fails",
        cause: "Document snapshot sha256 does not match content",
      },
    });
    expect(typeof res.json().details.chatId).toBe("string");
    expect(await tableCount(app, chats)).toBe(1);
    expect(await tableCount(app, messages)).toBe(0);
  });
});

describe("Agent chat create-and-send rate limit", () => {
  const getApp = useTestApp({ rateLimit: { agentMessageMax: 2 } });

  it("shares the per-agent message write limiter", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `create-rl-${crypto.randomUUID().slice(0, 6)}-s` });
    const target = await createTestAgent(app, { name: `create-rl-${crypto.randomUUID().slice(0, 6)}-t` });

    const create = (i: number) =>
      sender.request("POST", "/api/v1/agent/chats/create-and-send", {
        operationId: `op-create-rl-${i}`,
        to: [target.agent.name],
        message: { format: "text", content: `limited ${i}` },
      });

    expect((await create(1)).statusCode).toBe(201);
    expect((await create(2)).statusCode).toBe(201);
    expect((await create(3)).statusCode).toBe(429);
  });
});

describe("Agent chat create-and-send replay before rate limit", () => {
  const getApp = useTestApp({ rateLimit: { agentMessageMax: 1 } });

  it("replays the same operation before consuming write quota but still limits new operations", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `create-replay-rl-${crypto.randomUUID().slice(0, 6)}-s` });
    const target = await createTestAgent(app, { name: `create-replay-rl-${crypto.randomUUID().slice(0, 6)}-t` });
    const payload = {
      operationId: "op-create-replay-before-rl",
      to: [target.agent.name],
      message: { format: "text", content: "limited replay" },
    };

    const first = await sender.request("POST", "/api/v1/agent/chats/create-and-send", payload);
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();

    const replay = await sender.request("POST", "/api/v1/agent/chats/create-and-send", payload);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      chat: firstBody.chat,
      message: firstBody.message,
      operationId: payload.operationId,
      replayed: true,
    });
    expect(await tableCount(app, chats)).toBe(1);
    expect(await tableCount(app, messages)).toBe(1);

    const newOperation = await sender.request("POST", "/api/v1/agent/chats/create-and-send", {
      operationId: "op-create-new-after-rl",
      to: [target.agent.name],
      message: { format: "text", content: "new operation should be limited" },
    });
    expect(newOperation.statusCode).toBe(429);
    expect(await tableCount(app, chats)).toBe(1);
    expect(await tableCount(app, messages)).toBe(1);
  });
});
