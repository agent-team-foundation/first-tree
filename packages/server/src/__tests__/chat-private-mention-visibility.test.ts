/**
 * Coverage for the "chat-scoped identity is membership-derived, not
 * discovery-derived" invariant from
 * `docs/agent-space-and-mention-visibility-design.zh-CN.md` §4.3.3 / §4.4.2.
 *
 * Two behaviours pinned:
 *
 *   1. `GET /api/v1/chats/:chatId` returns each participant's full
 *      `name / displayName / type` even when the caller is not the
 *      manager of a `visibility=private` participant. The membership
 *      itself is the trust boundary — without this, a private agent in
 *      a group chat shows up as a UUID prefix for everyone except its
 *      manager (issue #372).
 *
 *   2. The service-layer `addMeChatParticipants` rejects non-owners
 *      from pulling a `visibility=private` agent into a chat. The
 *      API-layer `assertAllAgentsVisibleInOrg` already enforces this
 *      via the discovery filter (404), but the service-layer check is
 *      the load-bearing invariant for any future entrypoint that
 *      bypasses the discovery filter.
 */

import { AGENT_VISIBILITY, type ChatDetail } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { addParticipant as agentAddParticipant, createChat as agentCreateChat } from "../services/chat.js";
import { addMeChatParticipants, createMeChat } from "../services/me-chat.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("chat-scoped identity rendering vs discovery visibility", () => {
  const getApp = useTestApp();

  it("GET /chats/:chatId surfaces a private participant's name even to non-managers", async () => {
    const app = getApp();
    // Two admins in the same default org. Alice owns a private agent X;
    // Bob is in the chat with Alice + X but has no management
    // relationship with X.
    const alice = await createTestAdmin(app);
    const bob = await createTestAdmin(app);

    const privateAgent = await createAgent(app.db, {
      name: `priv-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Alice's Private Agent",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });

    // Alice spins up a group chat she + Bob + private agent X are in.
    // (Three speakers → group.)
    const { chatId } = await createMeChat(app.db, alice.humanAgentUuid, alice.organizationId, {
      participantIds: [bob.humanAgentUuid, privateAgent.uuid],
    });

    // Bob — who can't "discover" Alice's private agent — fetches the
    // chat. Identity rendering inside the chat must NOT be filtered
    // by visibility: Bob must see the real name and displayName.
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<ChatDetail>();
    const xRow = body.participants.find((p) => p.agentId === privateAgent.uuid);
    expect(xRow).toBeDefined();
    expect(xRow?.name).toBe(privateAgent.name);
    expect(xRow?.displayName).toBe("Alice's Private Agent");
    expect(xRow?.type).toBe("agent");
  });

  it("addMeChatParticipants rejects a non-owner who tries to add a private agent", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const bob = await createTestAdmin(app);

    // Alice owns a private agent; Bob has a chat with Alice but does
    // not manage the private agent.
    const privateAgent = await createAgent(app.db, {
      name: `priv-add-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Alice's Private Agent",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });

    // Bob creates a direct chat with Alice (Bob is the speaker we'll
    // exercise the add-participant gate on).
    const { chatId } = await createMeChat(app.db, bob.humanAgentUuid, bob.organizationId, {
      participantIds: [alice.humanAgentUuid],
    });

    // Bob attempts to pull Alice's private agent into the chat. The
    // service-layer owner-exclusive check must refuse — even though
    // Bob is a legitimate speaker in the chat, he cannot grant the
    // exposure consent for an agent he does not own.
    await expect(
      addMeChatParticipants(app.db, chatId, bob.humanAgentUuid, bob.organizationId, {
        participantIds: [privateAgent.uuid],
      }),
    ).rejects.toThrow(/private agent/i);
  });

  it("addMeChatParticipants accepts the owner adding their own private agent", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const bob = await createTestAdmin(app);

    const privateAgent = await createAgent(app.db, {
      name: `priv-self-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Alice's Private Agent",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });

    const { chatId } = await createMeChat(app.db, alice.humanAgentUuid, alice.organizationId, {
      participantIds: [bob.humanAgentUuid],
    });

    // Owner adding her own private agent — the natural "invite-as-consent" path.
    await expect(
      addMeChatParticipants(app.db, chatId, alice.humanAgentUuid, alice.organizationId, {
        participantIds: [privateAgent.uuid],
      }),
    ).resolves.not.toThrow();
  });

  it("createMeChat rejects a non-owner who tries to include a private agent at creation time", async () => {
    // Same invariant as addMeChatParticipants, but on the create path.
    // RFC §4.4.2 expects the service-layer gate on every chat-membership
    // write — closing the create-side bypass.
    const app = getApp();
    const alice = await createTestAdmin(app);
    const bob = await createTestAdmin(app);

    const privateAgent = await createAgent(app.db, {
      name: `priv-create-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Alice's Private Agent",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });

    await expect(
      createMeChat(app.db, bob.humanAgentUuid, bob.organizationId, {
        participantIds: [alice.humanAgentUuid, privateAgent.uuid],
      }),
    ).rejects.toThrow(/private agent/i);
  });

  it("agent-SDK createChat rejects a private target owned by a different member", async () => {
    // Agent-SDK path (POST /api/v1/agent/chats) hits services/chat.ts
    // createChat; without the owner-exclusive gate, an autonomous agent
    // controlled by Bob could pull Alice's private agent into a fresh
    // chat purely on the agent SDK.
    const app = getApp();
    const alice = await createTestAdmin(app);
    const bob = await createTestAdmin(app);

    // Bob's agent — the "caller" on the agent-SDK side. visibility
    // defaults to organization for agent so it doesn't
    // entangle the test with discovery rules.
    const bobsAgent = await createAgent(app.db, {
      name: `bob-agent-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Bob's Agent",
      managerId: bob.memberId,
      organizationId: bob.organizationId,
    });

    const alicesPrivate = await createAgent(app.db, {
      name: `alice-priv-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Alice's Private Agent",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });

    await expect(
      agentCreateChat(app.db, bobsAgent.uuid, {
        type: "group",
        participantIds: [alicesPrivate.uuid, alice.humanAgentUuid],
      }),
    ).rejects.toThrow(/private agent/i);
  });

  it("agent-SDK addParticipant rejects a private target owned by a different member", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const bob = await createTestAdmin(app);

    const bobsAgent = await createAgent(app.db, {
      name: `bob-agent-add-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Bob's Agent",
      managerId: bob.memberId,
      organizationId: bob.organizationId,
    });

    const alicesPrivate = await createAgent(app.db, {
      name: `alice-priv-add-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Alice's Private Agent",
      managerId: alice.memberId,
      organizationId: alice.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });

    // Bob's agent first creates a chat with Bob (no private targets) —
    // legitimate so we can exercise the add-participant gate next.
    const chat = await agentCreateChat(app.db, bobsAgent.uuid, {
      type: "group",
      participantIds: [bob.humanAgentUuid],
    });
    if (!chat.id) throw new Error("Unexpected: createChat returned no id");

    await expect(agentAddParticipant(app.db, chat.id, bobsAgent.uuid, { agentId: alicesPrivate.uuid })).rejects.toThrow(
      /private agent/i,
    );
  });
});
