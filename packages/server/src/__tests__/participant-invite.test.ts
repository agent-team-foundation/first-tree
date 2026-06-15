import { randomUUID } from "node:crypto";
import { AGENT_VISIBILITY } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { createChat } from "../services/chat.js";
import * as memberService from "../services/member.js";
import { sendMessage } from "../services/message.js";
import { assertChatVisibleInOrgOrNotFound, inviteParticipantsToChat } from "../services/participant-invite.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

/**
 * Layer-2 invite service contract. Both the agent-JWT path
 * (`chat.ts::addParticipant`) and the user-JWT web path
 * (`me-chat.ts::addMeChatParticipants`) collapse onto
 * `inviteParticipantsToChat`. These tests pin the shared contract directly
 * at the service layer so any future entrypoint that delegates here
 * inherits the same behaviour.
 */
describe("inviteParticipantsToChat", () => {
  const getApp = useTestApp();

  it("rejects an empty target list", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "agent" });
    const chat = await createChat(app.db, owner.agent.uuid, { type: "group", participantIds: [] });

    await expect(
      inviteParticipantsToChat(app.db, {
        chatId: chat.id,
        callerAgentId: owner.agent.uuid,
        targetAgentIds: [],
        errorOnAlreadySpeaker: false,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it("404s when the chat does not exist", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "agent" });
    const target = await createTestAgent(app, { type: "agent" });

    await expect(
      inviteParticipantsToChat(app.db, {
        chatId: "00000000-0000-0000-0000-000000000000",
        callerAgentId: owner.agent.uuid,
        targetAgentIds: [target.agent.uuid],
        errorOnAlreadySpeaker: true,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("refuses a caller who is not a speaker of the chat (ForbiddenError)", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "agent" });
    const stranger = await createTestAgent(app, { type: "agent" });
    const target = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, { type: "group", participantIds: [] });

    await expect(
      inviteParticipantsToChat(app.db, {
        chatId: chat.id,
        callerAgentId: stranger.agent.uuid,
        targetAgentIds: [target.agent.uuid],
        errorOnAlreadySpeaker: true,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("rejects unknown target agents with BadRequestError (listing the missing ids)", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "agent" });
    const chat = await createChat(app.db, owner.agent.uuid, { type: "group", participantIds: [] });

    await expect(
      inviteParticipantsToChat(app.db, {
        chatId: chat.id,
        callerAgentId: owner.agent.uuid,
        targetAgentIds: ["00000000-0000-0000-0000-000000000000"],
        errorOnAlreadySpeaker: true,
      }),
    ).rejects.toThrow(/Agents not found/);
  });

  it("rejects removed human mirrors as explicit invite targets", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `invite-admin-${randomUUID().slice(0, 8)}` });
    const target = await memberService.createMember(app.db, admin.organizationId, {
      username: `invite-removed-${randomUUID().slice(0, 8)}`,
      displayName: "Invite Removed",
      role: "member",
    });
    await memberService.deleteMember(app.db, target.id, admin.organizationId);

    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [] });
    await expect(
      inviteParticipantsToChat(app.db, {
        chatId: chat.id,
        callerAgentId: admin.humanAgentUuid,
        targetAgentIds: [target.agentId],
        errorOnAlreadySpeaker: true,
      }),
    ).rejects.toThrow(/Inactive participant/);
  });

  it("rejects removed human mirrors during legacy chat creation", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `legacy-admin-${randomUUID().slice(0, 8)}` });
    const target = await memberService.createMember(app.db, admin.organizationId, {
      username: `legacy-removed-${randomUUID().slice(0, 8)}`,
      displayName: "Legacy Removed",
      role: "member",
    });
    await memberService.deleteMember(app.db, target.id, admin.organizationId);

    await expect(
      createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [target.agentId] }),
    ).rejects.toThrow(/inactive participant/);
  });

  it("rejects cross-org targets with BadRequestError", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "agent" });
    // `createTestAgent` resolves the *default* org for every call, so two
    // agents created back-to-back land in the same org. To produce a
    // cross-org target we rewrite the agent's organization_id post hoc.
    const stranger = await createTestAgent(app, { type: "agent" });
    const otherOrgId = "11111111-1111-1111-1111-111111111111";
    const { organizations } = await import("../db/schema/organizations.js");
    await app.db.insert(organizations).values({ id: otherOrgId, name: "Other Org", displayName: "Other Org" });
    await app.db.update(agents).set({ organizationId: otherOrgId }).where(eq(agents.uuid, stranger.agent.uuid));

    const chat = await createChat(app.db, owner.agent.uuid, { type: "group", participantIds: [] });

    await expect(
      inviteParticipantsToChat(app.db, {
        chatId: chat.id,
        callerAgentId: owner.agent.uuid,
        targetAgentIds: [stranger.agent.uuid],
        errorOnAlreadySpeaker: true,
      }),
    ).rejects.toThrow(/Cross-organization/);
  });

  it("refuses a non-owner inviting a private target (owner-exclusive rule)", async () => {
    const app = getApp();
    // Caller and target are in the same org but managed by different members.
    const caller = await createTestAgent(app, { type: "agent" });
    const targetOwner = await createTestAgent(app, { type: "agent" });

    // Pin the target's org to caller's org and mark it private.
    await app.db
      .update(agents)
      .set({ organizationId: caller.organizationId, visibility: AGENT_VISIBILITY.PRIVATE })
      .where(eq(agents.uuid, targetOwner.agent.uuid));

    const chat = await createChat(app.db, caller.agent.uuid, { type: "group", participantIds: [] });

    await expect(
      inviteParticipantsToChat(app.db, {
        chatId: chat.id,
        callerAgentId: caller.agent.uuid,
        targetAgentIds: [targetOwner.agent.uuid],
        errorOnAlreadySpeaker: true,
      }),
    ).rejects.toThrow(/Only the owner/);
  });

  it("throws ConflictError on already-speaker target when errorOnAlreadySpeaker=true", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "agent" });
    const peer = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });

    await expect(
      inviteParticipantsToChat(app.db, {
        chatId: chat.id,
        callerAgentId: owner.agent.uuid,
        targetAgentIds: [peer.agent.uuid],
        errorOnAlreadySpeaker: true,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("silently skips already-speaker targets when errorOnAlreadySpeaker=false (partial-idempotent batch)", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "agent" });
    const existingSpeaker = await createTestAgent(app, { type: "agent" });
    const brandNew = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [existingSpeaker.agent.uuid],
    });

    await inviteParticipantsToChat(app.db, {
      chatId: chat.id,
      callerAgentId: owner.agent.uuid,
      targetAgentIds: [existingSpeaker.agent.uuid, brandNew.agent.uuid],
      errorOnAlreadySpeaker: false,
    });

    const speakers = await app.db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.accessMode, "speaker")));
    const speakerIds = new Set(speakers.map((s) => s.agentId));
    expect(speakerIds.has(existingSpeaker.agent.uuid)).toBe(true);
    expect(speakerIds.has(brandNew.agent.uuid)).toBe(true);
  });

  it("is a true no-op when every target is already a speaker (no write, no recompute side-effects)", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "agent" });
    const peer = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });

    // Sanity: peer is already a speaker.
    const beforeRows = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(eq(chatMembership.chatId, chat.id));

    await inviteParticipantsToChat(app.db, {
      chatId: chat.id,
      callerAgentId: owner.agent.uuid,
      targetAgentIds: [peer.agent.uuid],
      errorOnAlreadySpeaker: false,
    });

    const afterRows = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(eq(chatMembership.chatId, chat.id));
    expect(afterRows.length).toBe(beforeRows.length);
  });

  it("brand-new invitee receives the silent-context backfill (regression for PR #545)", async () => {
    // Direct service-level proof that the backfill invariant inherited from
    // `addChatParticipants` survives the Layer-2 collapse. PR #545's tests
    // pinned this on the addParticipant/addMeChatParticipants entrypoints;
    // here we pin it on the underlying invite service so any future Layer-3
    // shell that delegates to invite inherits the assertion for free.
    const app = getApp();
    const owner = await createTestAdmin(app, { username: `backfill-owner-${randomUUID().slice(0, 8)}` });
    const peer = await createTestAgent(app, { type: "agent" });
    const newcomer = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.humanAgentUuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    for (let i = 0; i < 6; i++) {
      await sendMessage(
        app.db,
        chat.id,
        owner.humanAgentUuid,
        {
          source: "api",
          format: "text",
          content: `inv-${i}`,
        },
        { allowRecipientlessSend: true },
      );
    }

    await inviteParticipantsToChat(app.db, {
      chatId: chat.id,
      callerAgentId: owner.humanAgentUuid,
      targetAgentIds: [newcomer.agent.uuid],
      errorOnAlreadySpeaker: true,
    });

    const silentRows = await app.db
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, newcomer.agent.inboxId),
          eq(inboxEntries.chatId, chat.id),
          eq(inboxEntries.notify, false),
          eq(inboxEntries.status, "pending"),
        ),
      );
    expect(silentRows.length).toBe(6);
  });

  it("self-add of a private agent is permitted (owner-exclusive carve-out)", async () => {
    // Agent rejoining a chat it already owns must not be blocked by the
    // owner-exclusive check, even if the agent is private. The carve-out
    // is the `t.uuid !== callerAgentId` clause inside the invite service:
    // private-owner-exclusive does not fire when caller IS the target.
    const app = getApp();
    const self = await createTestAgent(app, { type: "agent" });
    await app.db.update(agents).set({ visibility: AGENT_VISIBILITY.PRIVATE }).where(eq(agents.uuid, self.agent.uuid));

    // `self` creates the chat → `self` is automatically a speaker (createChat
    // includes the creator). Private agents are allowed to land in chats
    // they own themselves; `createChat` shares the same self-add carve-out.
    const chat = await createChat(app.db, self.agent.uuid, { type: "group", participantIds: [] });

    // `self` invites `self`. Without the carve-out this would raise
    // ForbiddenError (private + caller !== target.managerId is the usual
    // owner-exclusive trip). With the carve-out, the call passes the gate
    // and the already-speaker silent-skip turns it into a no-op.
    await expect(
      inviteParticipantsToChat(app.db, {
        chatId: chat.id,
        callerAgentId: self.agent.uuid,
        targetAgentIds: [self.agent.uuid],
        errorOnAlreadySpeaker: false,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("assertChatVisibleInOrgOrNotFound", () => {
  const getApp = useTestApp();

  it("404s when the chat does not exist", async () => {
    const app = getApp();
    const caller = await createTestAdmin(app, { username: `visible-missing-${randomUUID().slice(0, 8)}` });
    await expect(
      assertChatVisibleInOrgOrNotFound(app.db, "00000000-0000-0000-0000-000000000000", caller.organizationId),
    ).rejects.toThrow(NotFoundError);
  });

  it("404s when the chat is in a different org from the caller (probing protection)", async () => {
    const app = getApp();
    const caller = await createTestAdmin(app, { username: `visible-cross-${randomUUID().slice(0, 8)}` });
    const chatOwner = await createTestAgent(app, { type: "agent" });
    const chat = await createChat(app.db, chatOwner.agent.uuid, { type: "group", participantIds: [] });

    // Force the chat into a different org so the caller can't see it.
    const otherOrgId = "22222222-2222-2222-2222-222222222222";
    const { organizations } = await import("../db/schema/organizations.js");
    const { chats } = await import("../db/schema/chats.js");
    await app.db.insert(organizations).values({
      id: otherOrgId,
      name: "Other Org for chat",
      displayName: "Other Org for chat",
    });
    await app.db.update(chats).set({ organizationId: otherOrgId }).where(eq(chats.id, chat.id));

    await expect(assertChatVisibleInOrgOrNotFound(app.db, chat.id, caller.organizationId)).rejects.toThrow(
      NotFoundError,
    );
  });

  it("passes when chat exists and is in the caller's org", async () => {
    const app = getApp();
    const caller = await createTestAdmin(app, { username: `visible-pass-${randomUUID().slice(0, 8)}` });
    const chat = await createChat(app.db, caller.humanAgentUuid, { type: "group", participantIds: [] });
    await expect(assertChatVisibleInOrgOrNotFound(app.db, chat.id, caller.organizationId)).resolves.toBeUndefined();
  });
});
