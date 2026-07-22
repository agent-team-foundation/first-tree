import type { SendMessage } from "@first-tree/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { members } from "../db/schema/members.js";
import { createAgent } from "../services/agent.js";
import {
  addParticipant,
  type CreateTaskChatInput,
  createChat,
  getChat,
  getChatDetail,
  isParticipant,
  listChats,
  listChatsForMember,
  resolveAgentIdsByNameInOrg,
} from "../services/chat.js";
import { createMember } from "../services/member.js";
import { createOrganization } from "../services/organization.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, createTestApp, TEST_AVATAR_AUTHORITY_TAG } from "./helpers.js";

describe("chat service edge coverage", () => {
  let app: FastifyInstance;
  class RollbackFixture extends Error {}

  const baseMessage = (overrides: Partial<SendMessage> = {}): SendMessage => ({
    format: "text",
    content: "hello",
    source: "api",
    ...overrides,
  });

  const taskInput = (overrides: Partial<CreateTaskChatInput> = {}): CreateTaskChatInput => ({
    mode: "task",
    initiatorAgentId: "agent-initiator",
    organizationId: "org",
    initialRecipientAgentIds: ["agent-recipient"],
    contextParticipantAgentIds: [],
    initialMessage: baseMessage(),
    source: "manual",
    ...overrides,
  });

  async function createManagedAgent(seed: {
    memberId: string;
    organizationId: string;
    clientId: string;
    suffix: string;
  }) {
    return createAgent(app.db, {
      name: `chat-edge-${seed.suffix}-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Chat Edge Agent",
      source: "admin-api",
      managerId: seed.memberId,
      clientId: seed.clientId,
      organizationId: seed.organizationId,
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects legacy chat creation without a body", async () => {
    const seed = await createAdminContext(app, { username: `chat-legacy-${crypto.randomUUID().slice(0, 8)}` });

    // @ts-expect-error Exercise the runtime guard for JS callers.
    await expect(createChat(app.db, seed.humanAgentUuid)).rejects.toThrow("Legacy chat creation requires a body");
  });

  it.each([
    {
      name: "missing recipients",
      override: { initialRecipientAgentIds: [] },
      message: "Task chat creation requires at least one initial recipient",
    },
    {
      name: "receiver names",
      override: { initialMessage: baseMessage({ receiverNames: ["agent"] }) },
      message: "receiverNames is not accepted",
    },
    {
      name: "agent final text",
      override: { initialMessage: baseMessage({ purpose: "agent-final-text" }) },
      message: "cannot be agent-final-text",
    },
    {
      name: "reply",
      override: { initialMessage: baseMessage({ inReplyTo: uuidv7() }) },
      message: "cannot be a reply",
    },
    {
      name: "cross-chat resolution",
      override: { initialMessage: baseMessage({ metadata: { resolves: { kind: "answered" } } }) },
      message: "cannot resolve a request",
    },
  ])("rejects task chat creation with $name", async ({ override, message }) => {
    await expect(createChat(app.db, taskInput(override))).rejects.toThrow(message);
  });

  it("rejects task chats with missing participants and beforeInitialMessage without idempotency", async () => {
    const seed = await createAdminContext(app, { username: `chat-task-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createManagedAgent({ ...seed, suffix: "valid-target" });

    await expect(
      createChat(
        app.db,
        taskInput({
          initiatorAgentId: seed.humanAgentUuid,
          organizationId: seed.organizationId,
          initialRecipientAgentIds: [uuidv7()],
        }),
      ),
    ).rejects.toThrow("Agents not found");

    await expect(
      createChat(
        app.db,
        taskInput({
          initiatorAgentId: seed.humanAgentUuid,
          organizationId: seed.organizationId,
          initialRecipientAgentIds: [agent.uuid],
          beforeInitialMessage: async () => {},
        }),
      ),
    ).rejects.toThrow("beforeInitialMessage requires an onboardingKickoffKey");
  });

  it("returns the existing onboarding kickoff chat on idempotent legacy agent retries", async () => {
    const seed = await createAdminContext(app, { username: `chat-kickoff-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createManagedAgent({ ...seed, suffix: "kickoff" });
    const kickoffKey = `kickoff-${crypto.randomUUID()}`;

    const first = await createChat(app.db, {
      mode: "legacy-empty-agent",
      creatorAgentId: seed.humanAgentUuid,
      participantAgentIds: [agent.uuid],
      topic: "Kickoff",
      metadata: { source: "test" },
      onboardingKickoffKey: kickoffKey,
    });
    const second = await createChat(app.db, {
      mode: "legacy-empty-agent",
      creatorAgentId: seed.humanAgentUuid,
      participantAgentIds: [agent.uuid],
      topic: "Duplicate kickoff",
      onboardingKickoffKey: kickoffKey,
    });

    expect(second.id).toBe(first.id);
    expect(second.participants.map((p) => p.agentId).sort()).toEqual([seed.humanAgentUuid, agent.uuid].sort());
  });

  it("rejects self-target task chat creation when the manager human mirror is missing", async () => {
    const seed = await createAdminContext(app, { username: `chat-self-target-${crypto.randomUUID().slice(0, 8)}` });
    const orphanManagerId = uuidv7();
    const orphanAgentId = uuidv7();
    await expect(
      app.db.transaction(async (tx) => {
        await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        await tx.insert(agents).values({
          uuid: orphanAgentId,
          name: `orphan-manager-${crypto.randomUUID().slice(0, 6)}`,
          organizationId: seed.organizationId,
          type: "agent",
          displayName: "Orphan Manager Agent",
          inboxId: `inbox_${orphanAgentId}`,
          managerId: orphanManagerId,
          status: "active",
        });

        await expect(
          createChat(
            tx as unknown as typeof app.db,
            taskInput({
              initiatorAgentId: orphanAgentId,
              organizationId: seed.organizationId,
              initialRecipientAgentIds: [orphanAgentId],
            }),
          ),
        ).rejects.toThrow(`Manager member "${orphanManagerId}" not found`);
        throw new RollbackFixture();
      }),
    ).rejects.toBeInstanceOf(RollbackFixture);
  });

  it("loads the manager human mirror for non-human self-target task chats", async () => {
    const seed = await createAdminContext(app, { username: `chat-self-ok-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createManagedAgent({ ...seed, suffix: "self-ok" });

    const chat = await createChat(
      app.db,
      taskInput({
        initiatorAgentId: agent.uuid,
        organizationId: seed.organizationId,
        initialRecipientAgentIds: [agent.uuid],
      }),
    );

    expect(chat.participants.map((p) => p.agentId).sort()).toEqual([agent.uuid, seed.humanAgentUuid].sort());
  });

  it("creates task chats with non-empty metadata and runs the kickoff hook once", async () => {
    const seed = await createAdminContext(app, { username: `chat-task-meta-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createManagedAgent({ ...seed, suffix: "task-meta" });
    const beforeInitialMessage = vi.fn(async () => {});
    const kickoffKey = `task-kickoff-${crypto.randomUUID()}`;

    const first = await createChat(
      app.db,
      taskInput({
        initiatorAgentId: seed.humanAgentUuid,
        organizationId: seed.organizationId,
        initialRecipientAgentIds: [agent.uuid],
        topic: "Kickoff topic",
        description: "Kickoff description",
        onboardingKickoffKey: kickoffKey,
        beforeInitialMessage,
      }),
    );
    const second = await createChat(
      app.db,
      taskInput({
        initiatorAgentId: seed.humanAgentUuid,
        organizationId: seed.organizationId,
        initialRecipientAgentIds: [agent.uuid],
        topic: "Ignored duplicate topic",
        description: "Ignored duplicate description",
        onboardingKickoffKey: kickoffKey,
        beforeInitialMessage,
      }),
    );

    expect(first.chat).toMatchObject({
      topic: "Kickoff topic",
      description: "Kickoff description",
    });
    expect(first.chat.descriptionUpdatedAt).toBeInstanceOf(Date);
    expect(first.initialMessageCreated).toBe(true);
    expect(second.chat.id).toBe(first.chat.id);
    expect(second.initialMessageCreated).toBe(false);
    expect(beforeInitialMessage).toHaveBeenCalledTimes(1);
  });

  it("normalizes empty task chat topic and description to null", async () => {
    const seed = await createAdminContext(app, { username: `chat-task-empty-meta-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createManagedAgent({ ...seed, suffix: "task-empty-meta" });

    const created = await createChat(
      app.db,
      taskInput({
        initiatorAgentId: seed.humanAgentUuid,
        organizationId: seed.organizationId,
        initialRecipientAgentIds: [agent.uuid],
        topic: "",
        description: "",
      }),
    );

    expect(created.chat).toMatchObject({
      topic: null,
      description: null,
      descriptionUpdatedAt: null,
    });
  });

  it("rejects task chats with inactive participants", async () => {
    const seed = await createAdminContext(app, { username: `chat-inactive-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createManagedAgent({ ...seed, suffix: "inactive" });
    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, agent.uuid));

    await expect(
      createChat(
        app.db,
        taskInput({
          initiatorAgentId: seed.humanAgentUuid,
          organizationId: seed.organizationId,
          initialRecipientAgentIds: [agent.uuid],
        }),
      ),
    ).rejects.toThrow(/Cannot create task chat with inactive participant/);
  });

  it("rejects task chats with inactive human member participants", async () => {
    const seed = await createAdminContext(app, { username: `chat-inactive-human-${crypto.randomUUID().slice(0, 8)}` });
    const inactiveMember = await createMember(app.db, seed.organizationId, {
      username: `chat-inactive-human-target-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Inactive Human Target",
      role: "member",
    });
    await app.db.update(members).set({ status: "removed" }).where(eq(members.id, inactiveMember.id));

    await expect(
      createChat(
        app.db,
        taskInput({
          initiatorAgentId: seed.humanAgentUuid,
          organizationId: seed.organizationId,
          initialRecipientAgentIds: [inactiveMember.agentId],
        }),
      ),
    ).rejects.toThrow(/Cannot create task chat with inactive participant/);
  });

  it("rejects task chats with cross-organization participants", async () => {
    const seed = await createAdminContext(app, { username: `chat-task-org-a-${crypto.randomUUID().slice(0, 8)}` });
    const otherOrg = await createOrganization(app.db, {
      name: `chat-task-org-b-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Chat Task Org B",
    });
    const otherMember = await createMember(app.db, otherOrg.id, {
      username: `chat-task-other-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Chat Task Other",
      role: "member",
    });

    await expect(
      createChat(
        app.db,
        taskInput({
          initiatorAgentId: seed.humanAgentUuid,
          organizationId: seed.organizationId,
          initialRecipientAgentIds: [otherMember.agentId],
        }),
      ),
    ).rejects.toThrow("Cross-organization chat not allowed");
  });

  it("rejects task chats targeting another member's private agent", async () => {
    const seed = await createAdminContext(app, { username: `chat-private-target-${crypto.randomUUID().slice(0, 8)}` });
    const privateOwner = await createMember(app.db, seed.organizationId, {
      username: `chat-private-owner-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Private Owner",
      role: "member",
    });
    const privateAgent = await createAgent(app.db, {
      name: `chat-private-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Private Target",
      managerId: privateOwner.id,
      organizationId: seed.organizationId,
      visibility: "private",
    });

    await expect(
      createChat(
        app.db,
        taskInput({
          initiatorAgentId: seed.humanAgentUuid,
          organizationId: seed.organizationId,
          initialRecipientAgentIds: [privateAgent.uuid],
        }),
      ),
    ).rejects.toThrow(/private agent/);
  });

  it("rejects legacy web chat creation for creator org mismatch and cross-org participants", async () => {
    const seed = await createAdminContext(app, { username: `chat-org-a-${crypto.randomUUID().slice(0, 8)}` });
    const otherOrg = await createOrganization(app.db, {
      name: `chat-org-b-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Chat Org B",
    });

    await expect(
      createChat(app.db, {
        mode: "legacy-empty-web",
        creatorAgentId: seed.humanAgentUuid,
        organizationId: otherOrg.id,
        participantAgentIds: [],
      }),
    ).rejects.toThrow(`Creator agent "${seed.humanAgentUuid}" is not in organization "${otherOrg.id}"`);

    const otherMember = await createMember(app.db, otherOrg.id, {
      username: `chat-other-member-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Chat Other Member",
      role: "member",
    });
    const crossOrgAgent = await createAgent(app.db, {
      name: `chat-cross-org-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Cross Org Agent",
      source: "admin-api",
      managerId: otherMember.id,
      organizationId: otherOrg.id,
    });

    await expect(
      createChat(app.db, seed.humanAgentUuid, { type: "group", participantIds: [crossOrgAgent.uuid] }),
    ).rejects.toThrow("Cross-organization chat not allowed");
  });

  it("covers exported lookup helpers for missing, empty, and membership cases", async () => {
    const seed = await createAdminContext(app, { username: `chat-helper-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createManagedAgent({ ...seed, suffix: "helper" });

    await expect(getChat(app.db, uuidv7())).rejects.toThrow("not found");
    await expect(resolveAgentIdsByNameInOrg(app.db, seed.organizationId, ["missing-agent"])).rejects.toThrow(
      "Agents not found by name",
    );
    await expect(resolveAgentIdsByNameInOrg(app.db, seed.organizationId, [])).resolves.toEqual([]);
    await expect(listChats(app.db, agent.uuid, 10)).resolves.toEqual({ items: [], nextCursor: null });

    const chat = await createChat(app.db, seed.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await expect(isParticipant(app.db, chat.id, seed.humanAgentUuid)).resolves.toBe(true);
    await expect(isParticipant(app.db, chat.id, uuidv7())).resolves.toBe(false);

    const resolved = await resolveAgentIdsByNameInOrg(app.db, seed.organizationId, [agent.name ?? ""]);
    expect(resolved).toEqual([agent.uuid]);
  });

  it("resolves detail viewer membership kind for admin, missing, participant, and watcher views", async () => {
    const seed = await createAdminContext(app, { username: `chat-detail-kind-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createManagedAgent({ ...seed, suffix: "detail-kind" });
    const chat = await createChat(app.db, seed.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    const watcherId = uuidv7();
    await app.db.insert(agents).values({
      uuid: watcherId,
      name: `chat-detail-watcher-${crypto.randomUUID().slice(0, 6)}`,
      organizationId: seed.organizationId,
      type: "agent",
      displayName: "Detail Watcher",
      inboxId: `inbox_${watcherId}`,
      managerId: seed.memberId,
      status: "active",
    });
    await app.db.insert(chatMembership).values({
      chatId: chat.id,
      agentId: watcherId,
      role: "member",
      accessMode: "watcher",
    });

    await expect(getChatDetail(app.db, chat.id, null, TEST_AVATAR_AUTHORITY_TAG)).resolves.toMatchObject({
      viewerMembershipKind: null,
    });
    await expect(getChatDetail(app.db, chat.id, uuidv7(), TEST_AVATAR_AUTHORITY_TAG)).resolves.toMatchObject({
      viewerMembershipKind: null,
    });
    await expect(getChatDetail(app.db, chat.id, seed.humanAgentUuid, TEST_AVATAR_AUTHORITY_TAG)).resolves.toMatchObject(
      {
        viewerMembershipKind: "participant",
      },
    );
    await expect(getChatDetail(app.db, chat.id, watcherId, TEST_AVATAR_AUTHORITY_TAG)).resolves.toMatchObject({
      viewerMembershipKind: "watching",
    });
  });

  it("adds participants by agent name and formats missing addParticipant selectors", async () => {
    const seed = await createAdminContext(app, { username: `chat-add-name-${crypto.randomUUID().slice(0, 8)}` });
    const agent = await createManagedAgent({ ...seed, suffix: "add-name" });
    const newcomer = await createManagedAgent({ ...seed, suffix: "add-name-target" });
    const chat = await createChat(app.db, seed.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });

    await expect(
      addParticipant(app.db, chat.id, seed.humanAgentUuid, { agentName: newcomer.name ?? "" }),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ agentId: newcomer.uuid })]));
    await expect(addParticipant(app.db, chat.id, seed.humanAgentUuid, {} as never)).rejects.toThrow(
      'Agent "(unknown)" not found',
    );
  });

  it("loads a fallback human agent in listChatsForMember when it is not managed by the member", async () => {
    const seed = await createAdminContext(app, { username: `chat-member-${crypto.randomUUID().slice(0, 8)}` });
    const other = await createAdminContext(app, { username: `chat-member-other-${crypto.randomUUID().slice(0, 8)}` });

    await app.db.update(agents).set({ managerId: other.memberId }).where(eq(agents.uuid, other.humanAgentUuid));

    await expect(listChatsForMember(app.db, seed.memberId, other.humanAgentUuid)).resolves.toEqual([]);
  });
});
