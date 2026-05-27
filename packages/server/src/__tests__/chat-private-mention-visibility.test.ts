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
import { rejectedPrivateTargets } from "../services/participant-invite.js";
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
      type: "autonomous_agent",
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
    expect(xRow?.type).toBe("autonomous_agent");
  });

  it("addMeChatParticipants rejects a non-owner who tries to add a private agent", async () => {
    const app = getApp();
    const alice = await createTestAdmin(app);
    const bob = await createTestAdmin(app);

    // Alice owns a private agent; Bob has a chat with Alice but does
    // not manage the private agent.
    const privateAgent = await createAgent(app.db, {
      name: `priv-add-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
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
      type: "autonomous_agent",
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
      type: "autonomous_agent",
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
    // defaults to organization for autonomous_agent so it doesn't
    // entangle the test with discovery rules.
    const bobsAgent = await createAgent(app.db, {
      name: `bob-agent-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "Bob's Agent",
      managerId: bob.memberId,
      organizationId: bob.organizationId,
    });

    const alicesPrivate = await createAgent(app.db, {
      name: `alice-priv-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
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
      type: "autonomous_agent",
      displayName: "Bob's Agent",
      managerId: bob.memberId,
      organizationId: bob.organizationId,
    });

    const alicesPrivate = await createAgent(app.db, {
      name: `alice-priv-add-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
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

  // ---------------------------------------------------------------------------
  // Strict owner-exclusive (RFC §4.5 strict reading): only the human-agent
  // manager of a private target may invite it. The cases above pin the
  // cross-manager rejection; the cases below pin the same-manager-but-
  // non-human-caller rejection — i.e. the social-engineering path where
  // M's public agent is instructed (via natural-language message or
  // otherwise) to bring M's sibling private agent in.
  // ---------------------------------------------------------------------------

  it("addParticipant rejects M's public agent trying to pull M's private agent (bug path)", async () => {
    // N1: this is the precise path the user reported — M is not in the
    // chat; someone else legitimately added M's public agent (org-visible,
    // anyone in the chat can add it); the public agent then turns around
    // and invites M's private agent, "tricking" the gate when the rule was
    // owner-exclusive in its lenient (shared-managerId) reading. Strict
    // reading rejects: caller must be human.
    const app = getApp();
    const m = await createTestAdmin(app);
    const bob = await createTestAdmin(app);

    const mPublic = await createAgent(app.db, {
      name: `m-pub-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "M's Public Agent",
      managerId: m.memberId,
      organizationId: m.organizationId,
      visibility: AGENT_VISIBILITY.ORGANIZATION,
    });
    const mPrivate = await createAgent(app.db, {
      name: `m-priv-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "M's Private Agent",
      managerId: m.memberId,
      organizationId: m.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });

    // Bob (different manager) creates a group chat with M's public agent.
    // Pulling a PUBLIC agent in is allowed under both readings of the rule.
    const chat = await agentCreateChat(app.db, bob.humanAgentUuid, {
      type: "group",
      participantIds: [mPublic.uuid],
    });
    if (!chat.id) throw new Error("Unexpected: createChat returned no id");

    // Now M's public agent tries to bring M's private agent in. Under the
    // lenient reading this was allowed (they share managerId). Strict
    // reading rejects — only M's human agent can invite M's private agent.
    await expect(agentAddParticipant(app.db, chat.id, mPublic.uuid, { agentId: mPrivate.uuid })).rejects.toThrow(
      /private agent/i,
    );
  });

  it("addParticipant rejects M's private agent trying to pull M's other private agent", async () => {
    // N2: same shape as N1, but caller is itself a private agent. Same
    // strict reading applies — caller must be human regardless of caller's
    // own visibility.
    const app = getApp();
    const m = await createTestAdmin(app);

    const mPrivateA = await createAgent(app.db, {
      name: `m-priv-a-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "M's Private Agent A",
      managerId: m.memberId,
      organizationId: m.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });
    const mPrivateB = await createAgent(app.db, {
      name: `m-priv-b-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "M's Private Agent B",
      managerId: m.memberId,
      organizationId: m.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });

    // M spins up a chat with privateA — 2 speakers is a legal v2 chat
    // (group is the only `chats.type` Hub writes now; 1:1 behaviour is
    // derived from `participants.length === 2`, see chat.ts:289).
    const chat = await agentCreateChat(app.db, m.humanAgentUuid, {
      type: "group",
      participantIds: [mPrivateA.uuid],
    });
    if (!chat.id) throw new Error("Unexpected: createChat returned no id");

    // privateA now tries to pull privateB in. Strict reading rejects.
    await expect(agentAddParticipant(app.db, chat.id, mPrivateA.uuid, { agentId: mPrivateB.uuid })).rejects.toThrow(
      /private agent/i,
    );
  });

  it("agent-SDK createChat rejects M's public agent including M's private agent as initial participant", async () => {
    // N3: same rule applies at chat-creation time. M's public agent
    // creating a fresh group chat with M's private agent listed in the
    // initial participants must be rejected by the same strict
    // owner-exclusive predicate. Closes the create-side bypass.
    const app = getApp();
    const m = await createTestAdmin(app);

    const mPublic = await createAgent(app.db, {
      name: `m-pub-create-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "M's Public Agent",
      managerId: m.memberId,
      organizationId: m.organizationId,
      visibility: AGENT_VISIBILITY.ORGANIZATION,
    });
    const mPrivate = await createAgent(app.db, {
      name: `m-priv-create-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "M's Private Agent",
      managerId: m.memberId,
      organizationId: m.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });

    await expect(
      agentCreateChat(app.db, mPublic.uuid, {
        type: "group",
        participantIds: [mPrivate.uuid, m.humanAgentUuid],
      }),
    ).rejects.toThrow(/private agent/i);
  });

  it("agent-SDK createChat rejects M's private agent including M's other private agent as initial participant", async () => {
    // N4: same as N3 but creator is itself private. Strict reading is
    // independent of creator's visibility — only `type === 'human'` matters.
    const app = getApp();
    const m = await createTestAdmin(app);

    const mPrivateA = await createAgent(app.db, {
      name: `m-priv-a-create-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "M's Private Agent A",
      managerId: m.memberId,
      organizationId: m.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });
    const mPrivateB = await createAgent(app.db, {
      name: `m-priv-b-create-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "M's Private Agent B",
      managerId: m.memberId,
      organizationId: m.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });

    await expect(
      agentCreateChat(app.db, mPrivateA.uuid, {
        type: "group",
        participantIds: [mPrivateB.uuid, m.humanAgentUuid],
      }),
    ).rejects.toThrow(/private agent/i);
  });

  it("HTTP web path: admin can pass discovery filter but is still rejected by the Layer-2 owner gate", async () => {
    // N5: `assertAllAgentsVisibleInOrg` (the API-layer discovery filter)
    // has an admin short-circuit — an admin can REFERENCE another member's
    // private agent uuid without getting a 404. But the Layer-2 service
    // gate has no admin override, so the call still 403s. This is the
    // "admin is a discovery-side affordance, not a consent-side one"
    // invariant explicit in `participant-invite.ts`.
    const app = getApp();
    const alice = await createTestAdmin(app); // both Alice and Bob have role=admin
    const bob = await createTestAdmin(app);

    // Bob owns a private agent. Alice (also admin) will try to pull it in
    // via the web HTTP route.
    const bobsPrivate = await createAgent(app.db, {
      name: `bob-priv-admin-${crypto.randomUUID().slice(0, 8)}`,
      type: "autonomous_agent",
      displayName: "Bob's Private Agent",
      managerId: bob.memberId,
      organizationId: bob.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });

    // Alice creates a chat she's a speaker in (just herself + a throwaway).
    // Use createMeChat so Alice is the speaker — she'll then exercise the
    // HTTP add-participant route against bobsPrivate.
    const { chatId } = await createMeChat(app.db, alice.humanAgentUuid, alice.organizationId, {
      participantIds: [bob.humanAgentUuid],
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/participants`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { participantIds: [bobsPrivate.uuid] },
    });

    // 403 is the strict reading's expected response: discovery short-
    // circuit let Alice past the API-layer 404, but Layer-2 refuses.
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/private agent/i);
  });

  it("rejectedPrivateTargets carve-out: a private agent self-add is allowed (pure-function unit)", async () => {
    // N6: the self-add (`target.uuid === caller.agentId`) carve-out lets
    // a private agent rejoin a chat it already owns — this matters for
    // runtime reconnects where the same private-agent uuid both authors
    // the call and is the target. The full service path covers this
    // around `errorOnAlreadySpeaker`; testing the pure predicate
    // directly avoids tangling the carve-out with already-speaker
    // conflict semantics.
    const selfUuid = crypto.randomUUID();
    const result = rejectedPrivateTargets({ agentId: selfUuid, memberId: "member-other", type: "autonomous_agent" }, [
      { uuid: selfUuid, visibility: "private", managerId: "member-original" },
    ]);
    expect(result).toEqual([]);

    // Sanity: same caller against a DIFFERENT private target with the same
    // managerId is still rejected (the carve-out is *only* for self-add).
    const otherUuid = crypto.randomUUID();
    const result2 = rejectedPrivateTargets({ agentId: selfUuid, memberId: "member-shared", type: "autonomous_agent" }, [
      { uuid: otherUuid, visibility: "private", managerId: "member-shared" },
    ]);
    expect(result2).toHaveLength(1);
    expect(result2[0]?.uuid).toBe(otherUuid);
  });
});
