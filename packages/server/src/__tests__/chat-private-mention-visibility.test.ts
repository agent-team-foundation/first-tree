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
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
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

  // ---------------------------------------------------------------------------
  // Owner-exclusive (RFC §4.5, shared-owner reading): any agent owned by the
  // target's manager may invite a private target; the manager and the
  // manager's agents act under one consent boundary. PR #601 implemented
  // the strict reading (caller MUST be `type=human`), which a follow-up
  // product decision (PR #604) reversed: an owner's agent acting on the
  // owner's behalf is intentional delegation, not a social-engineering
  // hole. The cases below pin BOTH (a) the cross-manager rejection (the
  // permission still does block "Bob pulls owner M's private agent")
  // AND (b) the same-manager admission (M's public agent / private
  // sibling can pull M's other private agent).
  // ---------------------------------------------------------------------------

  it("addParticipant allows M's public agent to pull M's private agent (owner-team delegation)", async () => {
    // N1: shared-owner reading admits this path. Bob (a different manager)
    // legitimately pulls M's public agent into a chat; M's public agent
    // then invites M's private agent. Both M-owned agents share `managerId
    // = M`, so the predicate treats the public agent as acting on M's
    // behalf and admits the private target. Bob himself still cannot invite
    // M's private agent directly — see the "rejects a non-owner" case
    // above for the cross-manager rejection that this PR keeps in place.
    const app = getApp();
    const m = await createTestAdmin(app);
    const bob = await createTestAdmin(app);

    const mPublic = await createAgent(app.db, {
      name: `m-pub-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "M's Public Agent",
      managerId: m.memberId,
      organizationId: m.organizationId,
      visibility: AGENT_VISIBILITY.ORGANIZATION,
    });
    const mPrivate = await createAgent(app.db, {
      name: `m-priv-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "M's Private Agent",
      managerId: m.memberId,
      organizationId: m.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });

    // Bob (different manager) creates a group chat with M's public agent.
    const chat = await agentCreateChat(app.db, bob.humanAgentUuid, {
      type: "group",
      participantIds: [mPublic.uuid],
    });
    if (!chat.id) throw new Error("Unexpected: createChat returned no id");

    // M's public agent pulls M's private agent in — shared `managerId`,
    // shared-owner reading admits.
    await expect(agentAddParticipant(app.db, chat.id, mPublic.uuid, { agentId: mPrivate.uuid })).resolves.not.toThrow();

    // Verify the private agent is now a speaker in the chat.
    const speakers = await app.db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(
        and(
          eq(chatMembership.chatId, chat.id),
          eq(chatMembership.agentId, mPrivate.uuid),
          eq(chatMembership.accessMode, "speaker"),
        ),
      );
    expect(speakers).toHaveLength(1);
  });

  it("addParticipant allows M's private agent to pull M's other private agent (shared-owner)", async () => {
    // N2: same shape as N1, but the caller is itself a private agent.
    // Shared-owner reading is type-agnostic — only `managerId` matches.
    const app = getApp();
    const m = await createTestAdmin(app);

    const mPrivateA = await createAgent(app.db, {
      name: `m-priv-a-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "M's Private Agent A",
      managerId: m.memberId,
      organizationId: m.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });
    const mPrivateB = await createAgent(app.db, {
      name: `m-priv-b-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "M's Private Agent B",
      managerId: m.memberId,
      organizationId: m.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });

    // M spins up a chat with privateA — 2 speakers is a legal v2 chat
    // (group is the only `chats.type` Hub writes now; 1:1 behaviour is
    // derived from `participants.length === 2`, see chat.ts).
    const chat = await agentCreateChat(app.db, m.humanAgentUuid, {
      type: "group",
      participantIds: [mPrivateA.uuid],
    });
    if (!chat.id) throw new Error("Unexpected: createChat returned no id");

    // privateA pulls privateB in — shared `managerId`, admitted.
    await expect(
      agentAddParticipant(app.db, chat.id, mPrivateA.uuid, { agentId: mPrivateB.uuid }),
    ).resolves.not.toThrow();

    const speakers = await app.db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(
        and(
          eq(chatMembership.chatId, chat.id),
          eq(chatMembership.agentId, mPrivateB.uuid),
          eq(chatMembership.accessMode, "speaker"),
        ),
      );
    expect(speakers).toHaveLength(1);
  });

  it("agent-SDK createChat admits M's public agent + M's private agent as initial participants", async () => {
    // N3: shared-owner reading applies at chat-creation time too. M's
    // public agent creating a fresh group chat with M's private agent
    // listed in the initial participants is admitted — same `managerId`.
    // The cross-manager rejection at create-time is covered by the
    // pre-existing "agent-SDK createChat rejects a private target
    // owned by a different member" case above; this case pins the
    // same-owner admission.
    const app = getApp();
    const m = await createTestAdmin(app);

    const mPublic = await createAgent(app.db, {
      name: `m-pub-create-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "M's Public Agent",
      managerId: m.memberId,
      organizationId: m.organizationId,
      visibility: AGENT_VISIBILITY.ORGANIZATION,
    });
    const mPrivate = await createAgent(app.db, {
      name: `m-priv-create-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
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
    ).resolves.not.toThrow();
  });

  it("agent-SDK createChat admits M's private agent + M's other private agent as initial participants", async () => {
    // N4: same as N3 but the creator is itself a private agent. Shared-
    // owner reading is type-agnostic — only `managerId` matters.
    const app = getApp();
    const m = await createTestAdmin(app);

    const mPrivateA = await createAgent(app.db, {
      name: `m-priv-a-create-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "M's Private Agent A",
      managerId: m.memberId,
      organizationId: m.organizationId,
      visibility: AGENT_VISIBILITY.PRIVATE,
    });
    const mPrivateB = await createAgent(app.db, {
      name: `m-priv-b-create-${crypto.randomUUID().slice(0, 8)}`,
      type: "agent",
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
    ).resolves.not.toThrow();
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
      type: "agent",
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

    // Discovery short-circuit lets admin Alice past the API-layer 404,
    // but Layer-2 still refuses cross-manager admission of a private
    // target — shared-owner reading is still owner-exclusive across
    // managers.
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/private agent/i);
  });

  it("rejectedPrivateTargets carve-outs: self-add + same-owner admit; cross-owner rejects (pure-function unit)", async () => {
    // N6: pure-function exercise of the three shared-owner predicate
    // outcomes — self-add carve-out, same-owner admission, cross-owner
    // rejection. Testing the predicate directly avoids tangling these
    // outcomes with the service layer's already-speaker / chat-exists
    // / caller-is-speaker preconditions.

    // (a) Self-add carve-out: caller invites itself. `managerId` mismatch
    //     is irrelevant — the carve-out short-circuits first. Matters
    //     for runtime reconnect of a private agent.
    const selfUuid = crypto.randomUUID();
    const selfAdd = rejectedPrivateTargets({ agentId: selfUuid, memberId: "member-other" }, [
      { uuid: selfUuid, visibility: "private", managerId: "member-original" },
    ]);
    expect(selfAdd).toEqual([]);

    // (b) Same-owner admission: caller and a DIFFERENT private target
    //     share `managerId`. Shared-owner reading admits — owner's
    //     agents act under owner's authority.
    const siblingUuid = crypto.randomUUID();
    const sameOwner = rejectedPrivateTargets({ agentId: selfUuid, memberId: "member-shared" }, [
      { uuid: siblingUuid, visibility: "private", managerId: "member-shared" },
    ]);
    expect(sameOwner).toEqual([]);

    // (c) Cross-owner rejection: caller and target are owned by
    //    different members. The owner-exclusive boundary still holds.
    const strangerUuid = crypto.randomUUID();
    const crossOwner = rejectedPrivateTargets({ agentId: selfUuid, memberId: "member-mine" }, [
      { uuid: strangerUuid, visibility: "private", managerId: "member-theirs" },
    ]);
    expect(crossOwner).toHaveLength(1);
    expect(crossOwner[0]?.uuid).toBe(strangerUuid);
  });
});
