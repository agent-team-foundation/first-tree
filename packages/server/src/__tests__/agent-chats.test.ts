import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { suspendAgent } from "../services/agent.js";
import { resolveTargetChat } from "../services/github-entity-chat.js";
import { createMeChat, leaveMeChat } from "../services/me-chat.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Chats API", () => {
  const getApp = useTestApp();

  it("creates a chat and retrieves it", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: "chat-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "chat-a2" });

    const createRes = await a.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.uuid],
      topic: "Test chat",
    });
    expect(createRes.statusCode).toBe(201);
    const chat = createRes.json();
    expect(chat.type).toBe("group");
    expect(chat.participants).toHaveLength(2);
    expect(chat.participants.map((p: { agentId: string }) => p.agentId).sort()).toEqual([a.agent.uuid, a2.uuid].sort());

    const getRes = await a.request("GET", `/api/v1/agent/chats/${chat.id}`);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().id).toBe(chat.id);
  });

  it("creates a task chat with an initial message, woken recipients, and silent context participants", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `task-src-${uid}` });
    const target = await createTestAgent(app, { name: `task-to-${uid}` });
    const context = await createTestAgent(app, { name: `task-with-${uid}` });

    const createRes = await sender.request("POST", "/api/v1/agent/chats", {
      mode: "task",
      initialRecipientAgentIds: [target.agent.uuid],
      initialRecipientNames: [],
      contextParticipantAgentIds: [context.agent.uuid],
      contextParticipantNames: [],
      topic: "Task create route",
      description: "checking the task chat create path",
      initialMessage: { source: "cli", format: "text", content: "please review" },
    });

    expect(createRes.statusCode).toBe(201);
    const body = createRes.json<{
      chatId: string;
      messageId: string;
      effectiveSenderId: string;
      initialRecipientAgentIds: string[];
      contextParticipantAgentIds: string[];
    }>();
    expect(body.effectiveSenderId).toBe(sender.agent.uuid);
    expect(body.initialRecipientAgentIds).toEqual([target.agent.uuid]);
    expect(body.contextParticipantAgentIds).toEqual([context.agent.uuid]);

    const [chatRow] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    expect(chatRow?.topic).toBe("Task create route");
    expect(chatRow?.description).toBe("checking the task chat create path");
    expect(chatRow?.metadata).toEqual({ source: "agent" });

    const participantRows = await app.db
      .select({ agentId: chatMembership.agentId, role: chatMembership.role, accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(eq(chatMembership.chatId, body.chatId));
    expect(participantRows).toEqual(
      expect.arrayContaining([
        { agentId: sender.agent.uuid, role: "owner", accessMode: "speaker" },
        { agentId: target.agent.uuid, role: "member", accessMode: "speaker" },
        { agentId: context.agent.uuid, role: "member", accessMode: "speaker" },
      ]),
    );

    const [messageRow] = await app.db.select().from(messages).where(eq(messages.id, body.messageId)).limit(1);
    expect(messageRow).toMatchObject({
      chatId: body.chatId,
      senderId: sender.agent.uuid,
      source: "cli",
      format: "text",
      content: `@${target.agent.name} please review`,
    });
    expect(messageRow?.metadata).toEqual({ mentions: [target.agent.uuid] });

    const targetInbox = await app.db
      .select({ notify: inboxEntries.notify, messageId: inboxEntries.messageId })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.chatId, body.chatId), eq(inboxEntries.inboxId, target.agent.inboxId)));
    expect(targetInbox).toEqual([{ notify: true, messageId: body.messageId }]);

    const contextInbox = await app.db
      .select({ notify: inboxEntries.notify, messageId: inboxEntries.messageId })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.chatId, body.chatId), eq(inboxEntries.inboxId, context.agent.inboxId)));
    expect(contextInbox).toEqual([{ notify: false, messageId: body.messageId }]);
  });

  it("creates a task chat by recipient names while keeping context participants silent", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `task-name-src-${uid}` });
    const target = await createTestAgent(app, { name: `task-name-to-${uid}` });
    const context = await createTestAgent(app, { name: `task-name-with-${uid}` });

    const createRes = await sender.request("POST", "/api/v1/agent/chats", {
      mode: "task",
      initialRecipientAgentIds: [],
      initialRecipientNames: [target.agent.name],
      contextParticipantAgentIds: [],
      contextParticipantNames: [context.agent.name],
      topic: "Task create names",
      initialMessage: { source: "cli", format: "text", content: "please review by name" },
    });

    expect(createRes.statusCode).toBe(201);
    const body = createRes.json<{
      chatId: string;
      messageId: string;
      initialRecipientAgentIds: string[];
      contextParticipantAgentIds: string[];
    }>();
    expect(body.initialRecipientAgentIds).toEqual([target.agent.uuid]);
    expect(body.contextParticipantAgentIds).toEqual([context.agent.uuid]);

    const [messageRow] = await app.db.select().from(messages).where(eq(messages.id, body.messageId)).limit(1);
    expect(messageRow?.content).toBe(`@${target.agent.name} please review by name`);
    expect(messageRow?.metadata).toEqual({ mentions: [target.agent.uuid] });

    const targetInbox = await app.db
      .select({ notify: inboxEntries.notify, messageId: inboxEntries.messageId })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.chatId, body.chatId), eq(inboxEntries.inboxId, target.agent.inboxId)));
    expect(targetInbox).toEqual([{ notify: true, messageId: body.messageId }]);

    const contextInbox = await app.db
      .select({ notify: inboxEntries.notify, messageId: inboxEntries.messageId })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.chatId, body.chatId), eq(inboxEntries.inboxId, context.agent.inboxId)));
    expect(contextInbox).toEqual([{ notify: false, messageId: body.messageId }]);
  });

  it("uses the manager human as effective sender when an agent creates a self-target task chat", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: `task-self-${crypto.randomUUID().slice(0, 6)}` });
    const [manager] = await app.db
      .select({ agentId: members.agentId })
      .from(members)
      .where(eq(members.id, sender.memberId))
      .limit(1);
    expect(manager?.agentId).toBeTruthy();

    const createRes = await sender.request("POST", "/api/v1/agent/chats", {
      mode: "task",
      initialRecipientAgentIds: [sender.agent.uuid],
      initialRecipientNames: [],
      contextParticipantAgentIds: [],
      contextParticipantNames: [],
      topic: "Self target",
      initialMessage: { source: "cli", format: "text", content: "check this" },
    });

    expect(createRes.statusCode).toBe(201);
    const body = createRes.json<{ chatId: string; messageId: string; effectiveSenderId: string }>();
    expect(body.effectiveSenderId).toBe(manager?.agentId);

    const [chatRow] = await app.db.select().from(chats).where(eq(chats.id, body.chatId)).limit(1);
    expect(chatRow?.metadata).toEqual({
      source: "agent",
      initiatedByAgentId: sender.agent.uuid,
      effectiveSenderReason: "self_target_manager_human",
    });

    const [messageRow] = await app.db.select().from(messages).where(eq(messages.id, body.messageId)).limit(1);
    expect(messageRow?.senderId).toBe(manager?.agentId);
    expect(messageRow?.metadata).toEqual({
      mentions: [sender.agent.uuid],
      initiatedByAgentId: sender.agent.uuid,
      effectiveSenderReason: "self_target_manager_human",
    });

    const ownerRows = await app.db
      .select({ agentId: chatMembership.agentId, role: chatMembership.role })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, body.chatId), eq(chatMembership.role, "owner")));
    expect(ownerRows).toEqual([{ agentId: manager?.agentId, role: "owner" }]);

    const selfInbox = await app.db
      .select({ notify: inboxEntries.notify, messageId: inboxEntries.messageId })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.chatId, body.chatId), eq(inboxEntries.inboxId, sender.agent.inboxId)));
    expect(selfInbox).toEqual([{ notify: true, messageId: body.messageId }]);
  });

  it("runs deterministic send preflight before inserting a task chat", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `task-preflight-src-${uid}` });
    const targetA = await createTestAgent(app, { name: `task-preflight-a-${uid}` });
    const targetB = await createTestAgent(app, { name: `task-preflight-b-${uid}` });
    const createTopic = `preflight-no-create-${uid}`;

    const createRes = await sender.request("POST", "/api/v1/agent/chats", {
      mode: "task",
      initialRecipientAgentIds: [targetA.agent.uuid, targetB.agent.uuid],
      initialRecipientNames: [],
      contextParticipantAgentIds: [],
      contextParticipantNames: [],
      topic: createTopic,
      initialMessage: { source: "cli", format: "request", content: "please choose" },
    });

    expect(createRes.statusCode).toBe(400);
    const leakedChats = await app.db.select({ id: chats.id }).from(chats).where(eq(chats.topic, createTopic));
    expect(leakedChats).toHaveLength(0);

    const agentRequestTopic = `preflight-agent-request-${uid}`;
    const agentRequestRes = await sender.request("POST", "/api/v1/agent/chats", {
      mode: "task",
      initialRecipientAgentIds: [targetA.agent.uuid],
      initialRecipientNames: [],
      contextParticipantAgentIds: [],
      contextParticipantNames: [],
      topic: agentRequestTopic,
      initialMessage: { source: "cli", format: "request", content: "please choose" },
    });

    expect(agentRequestRes.statusCode).toBe(400);
    const leakedAgentRequestChats = await app.db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.topic, agentRequestTopic));
    expect(leakedAgentRequestChats).toHaveLength(0);
  });

  it("does not fall back to legacy empty-chat creation when a task payload is malformed", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `task-malformed-src-${uid}` });
    const target = await createTestAgent(app, { name: `task-malformed-to-${uid}` });
    const createTopic = `task-malformed-no-create-${uid}`;

    const createRes = await sender.request("POST", "/api/v1/agent/chats", {
      mode: "task",
      type: "group",
      participantIds: [target.agent.uuid],
      topic: createTopic,
    });

    expect(createRes.statusCode).toBe(400);
    const leakedChats = await app.db.select({ id: chats.id }).from(chats).where(eq(chats.topic, createTopic));
    expect(leakedChats).toHaveLength(0);
  });

  it("rejects inactive task-create targets before inserting a chat", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const sender = await createTestAgent(app, { name: `task-inactive-src-${uid}` });
    const target = await createTestAgent(app, { name: `task-inactive-to-${uid}` });
    const createTopic = `task-inactive-no-create-${uid}`;
    await suspendAgent(app.db, target.agent.uuid);

    const createRes = await sender.request("POST", "/api/v1/agent/chats", {
      mode: "task",
      initialRecipientAgentIds: [target.agent.uuid],
      initialRecipientNames: [],
      contextParticipantAgentIds: [],
      contextParticipantNames: [],
      topic: createTopic,
      initialMessage: { source: "cli", format: "text", content: "please review" },
    });

    expect(createRes.statusCode).toBe(400);
    const leakedChats = await app.db.select({ id: chats.id }).from(chats).where(eq(chats.topic, createTopic));
    expect(leakedChats).toHaveLength(0);
  });

  it("lists chats for an agent", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: "list-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "list-a2" });

    await a.request("POST", "/api/v1/agent/chats", { type: "group", participantIds: [a2.uuid] });

    const res = await a.request("GET", "/api/v1/agent/chats");
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects chat creation with non-existent participant", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: "bad-a1" });

    const res = await a.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: ["non-existent"],
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects access to non-participant chat", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "deny-a1" });
    const a2 = await createTestAgent(app, { name: "deny-a2" });
    const { agent: a3 } = await createTestAgent(app, { name: "deny-a3" });

    const createRes = await a2.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a3.uuid],
    });
    const chatId = createRes.json().id;

    const res = await a1.request("GET", `/api/v1/agent/chats/${chatId}`);
    expect(res.statusCode).toBe(403);
  });

  it("GET /chats/:id/participants returns agent names for mention resolution", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `parts-a1-${uid}`, displayName: "Alice" });
    const { agent: a2 } = await createTestAgent(app, { name: `parts-a2-${uid}`, displayName: "Bob" });

    const createRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.uuid],
    });
    const chatId = createRes.json().id;

    const res = await a1.request("GET", `/api/v1/agent/chats/${chatId}/participants`);
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{
      agentId: string;
      name: string | null;
      displayName: string | null;
      mode: string;
      type: string;
    }>;

    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.agentId, r]));
    expect(byId.get(a1.agent.uuid)?.name).toBe(`parts-a1-${uid}`);
    expect(byId.get(a2.uuid)?.displayName).toBe("Bob");
    for (const r of rows) {
      // Agent↔agent direct → both start in mention_only (migration 0029).
      expect(r.mode).toBe("mention_only");
      expect(r.type).toBe("agent");
    }
  });

  it("GET /chats/:id/participants rejects non-participants with 403", async () => {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const a1 = await createTestAgent(app, { name: `secret-a1-${uid}` });
    const { agent: a2 } = await createTestAgent(app, { name: `secret-a2-${uid}` });
    const a3 = await createTestAgent(app, { name: `secret-a3-${uid}` });

    const createRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.uuid],
    });
    const chatId = createRes.json().id;

    const res = await a3.request("GET", `/api/v1/agent/chats/${chatId}/participants`);
    expect(res.statusCode).toBe(403);
  });

  describe("PATCH /chats/:id (set topic / description)", () => {
    it("updates topic and persists; null clears", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `topic-a1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `topic-a2-${uid}` });

      const createRes = await a1.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [a2.uuid],
      });
      const chatId = createRes.json().id;

      const setRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, { topic: "ship plan" });
      expect(setRes.statusCode).toBe(200);
      expect(setRes.json().topic).toBe("ship plan");

      const detailRes = await a1.request("GET", `/api/v1/agent/chats/${chatId}`);
      expect(detailRes.json().topic).toBe("ship plan");

      const clearRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, { topic: null });
      expect(clearRes.statusCode).toBe(200);
      expect(clearRes.json().topic).toBeNull();
    });

    it("updates description and persists; null clears", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `desc-a1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `desc-a2-${uid}` });

      const createRes = await a1.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [a2.uuid],
      });
      const chatId = createRes.json().id;

      const setRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, {
        description: "reviewing PR #42; CI green; awaiting approval",
      });
      expect(setRes.statusCode).toBe(200);
      expect(setRes.json().description).toBe("reviewing PR #42; CI green; awaiting approval");

      const detailRes = await a1.request("GET", `/api/v1/agent/chats/${chatId}`);
      expect(detailRes.json().description).toBe("reviewing PR #42; CI green; awaiting approval");

      const clearRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, { description: null });
      expect(clearRes.statusCode).toBe(200);
      expect(clearRes.json().description).toBeNull();
    });

    it("updates topic and description together; a single-field update leaves the other untouched", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `both-a1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `both-a2-${uid}` });

      const createRes = await a1.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [a2.uuid],
      });
      const chatId = createRes.json().id;

      const bothRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, {
        topic: "ship plan",
        description: "drafting the rollout steps",
      });
      expect(bothRes.statusCode).toBe(200);
      expect(bothRes.json().topic).toBe("ship plan");
      expect(bothRes.json().description).toBe("drafting the rollout steps");

      // Updating only the description must not clobber the existing topic.
      const descOnlyRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, {
        description: "rollout steps reviewed",
      });
      expect(descOnlyRes.statusCode).toBe(200);
      expect(descOnlyRes.json().topic).toBe("ship plan");
      expect(descOnlyRes.json().description).toBe("rollout steps reviewed");
    });

    it("rejects non-participants with 403", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `topic-deny-a1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `topic-deny-a2-${uid}` });
      const a3 = await createTestAgent(app, { name: `topic-deny-a3-${uid}` });

      const createRes = await a1.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [a2.uuid],
      });
      const chatId = createRes.json().id;

      const res = await a3.request("PATCH", `/api/v1/agent/chats/${chatId}`, { topic: "intrusion" });
      expect(res.statusCode).toBe(403);
    });

    it("rejects non-owner participants (speakers) with 403 in an agent-created chat", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `topic-owner-${uid}` });
      const a2 = await createTestAgent(app, { name: `topic-member-${uid}` });

      // a1 (an agent) creates the chat (→ membership role "owner"); a2 joins
      // as a speaker (role "member"). The chat's owner is agent-type, so the
      // delegate relaxation does not apply: a2 is a full participant but NOT
      // the owner.
      const createRes = await a1.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [a2.agent.uuid],
      });
      const chatId = createRes.json().id;

      // Owner succeeds.
      const ownerRes = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, { topic: "owner set" });
      expect(ownerRes.statusCode).toBe(200);

      // Non-owner participant is refused even though it can speak in the chat.
      const memberRes = await a2.request("PATCH", `/api/v1/agent/chats/${chatId}`, { topic: "member tries" });
      expect(memberRes.statusCode).toBe(403);

      // Topic is unchanged by the rejected write.
      const detailRes = await a1.request("GET", `/api/v1/agent/chats/${chatId}`);
      expect(detailRes.json().topic).toBe("owner set");
    });

    it("lets a worker agent update topic/description in a human-created (Web) chat", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      // Real Web-console creation path: `createMeChat` writes the human agent
      // as role "owner" and the worker agent as role "member". The delegate
      // relaxation makes the worker count as the owner for metadata writes.
      const human = await createTestAgent(app, { name: `web-human-${uid}`, type: "human" });
      const worker = await createTestAgent(app, { name: `web-worker-${uid}` });

      const { chatId } = await createMeChat(app.db, human.agent.uuid, human.organizationId, {
        participantIds: [worker.agent.uuid],
      });

      const res = await worker.request("PATCH", `/api/v1/agent/chats/${chatId}`, {
        topic: "worker set",
        description: "worker keeps the running state fresh",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().topic).toBe("worker set");
      expect(res.json().description).toBe("worker keeps the running state fresh");
    });

    it("keeps the worker agent's write access after the human owner leaves the chat", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const human = await createTestAgent(app, { name: `leave-human-${uid}`, type: "human" });
      const worker = await createTestAgent(app, { name: `leave-worker-${uid}` });

      const { chatId } = await createMeChat(app.db, human.agent.uuid, human.organizationId, {
        participantIds: [worker.agent.uuid],
      });

      // The human owner leaves. `leaveAsParticipant` either downgrades the
      // owner row to a watcher or deletes it — in both shapes the chat no
      // longer has an agent-type owner speaker, so the worker must keep its
      // delegate write access (the gate must not require the owner row to be
      // a speaker).
      await leaveMeChat(app.db, chatId, human.agent.uuid);

      const res = await worker.request("PATCH", `/api/v1/agent/chats/${chatId}`, {
        description: "still maintained after the owner left",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().description).toBe("still maintained after the owner left");
    });

    it("lets the delegate agent update topic/description in a GitHub-minted entity chat", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      // Real GitHub-webhook creation path: `resolveTargetChat` mints the chat
      // via `createChat(db, humanAgentId, ...)`, so the human agent is the
      // owner and the delegate that receives the webhook is a member. The
      // delegate relaxation makes it count as the owner for metadata writes.
      const admin = await createTestAdmin(app);
      const delegate = await createTestAgent(app, { name: `gh-delegate-${uid}` });

      const resolved = await resolveTargetChat(app.db, {
        organizationId: admin.organizationId,
        humanAgentId: admin.humanAgentUuid,
        delegateAgentId: delegate.agent.uuid,
        entity: {
          type: "pull_request",
          key: `owner/repo#${Math.floor(Math.random() * 100000)}`,
          title: "Owner-gate delegate test",
          url: "https://github.com/owner/repo/pull/0",
        },
        relatedEntities: [],
        eventType: "pull_request",
        action: "opened",
        isMentionMatched: true,
      });
      expect(resolved).not.toBeNull();
      if (!resolved) throw new Error("unreachable");

      const res = await delegate.request("PATCH", `/api/v1/agent/chats/${resolved.chatId}`, {
        description: "delegate refreshes the running state",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().description).toBe("delegate refreshes the running state");
    });

    it("rejects empty body (no topic or description)", async () => {
      const app = getApp();
      const uid = crypto.randomUUID().slice(0, 6);
      const a1 = await createTestAgent(app, { name: `topic-bad-a1-${uid}` });
      const { agent: a2 } = await createTestAgent(app, { name: `topic-bad-a2-${uid}` });

      const createRes = await a1.request("POST", "/api/v1/agent/chats", {
        type: "group",
        participantIds: [a2.uuid],
      });
      const chatId = createRes.json().id;

      const res = await a1.request("PATCH", `/api/v1/agent/chats/${chatId}`, {});
      expect(res.statusCode).toBe(400);
    });
  });
});
