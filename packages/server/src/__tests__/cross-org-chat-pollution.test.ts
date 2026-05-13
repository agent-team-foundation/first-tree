import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { organizations } from "../db/schema/organizations.js";
import { BadRequestError } from "../errors.js";
import { createAgent } from "../services/agent.js";
import { findOrCreateDirectChat } from "../services/chat.js";
import { listMeChats } from "../services/me-chat.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Regression coverage for cross-org direct-chat pollution.
 *
 * Each test sets up a user in org-A and a separate org-B with its own agents.
 * The bugs we are pinning down:
 *
 *   - A. `findOrCreateDirectChat` used to accept cross-org pairs and even
 *        reuse a dirty cross-org chat whose participants happened to include
 *        both ends — producing chats with `organization_id` disagreeing with
 *        a participant's `organization_id`.
 *   - C. `listMeChats` looked up membership purely by `chat_participants.agent_id`
 *        with no org filter, so any historical cross-org dirty chat that
 *        still listed the caller's human agent leaked into the org-A workspace
 *        list (and 404'd on click via `requireChatAccess`).
 */
describe("cross-org direct chat pollution — guard rails", () => {
  const getApp = useTestApp();

  /**
   * Create a foreign organization with a single agent in it.
   *
   * We use a raw INSERT instead of `createAgent` here because the service
   * insists on a manager member of the target org — and a full
   * admin/user/member bootstrap inside a side org isn't worth the boilerplate
   * for this regression suite. `manager_id` is NOT NULL, so we point it at
   * the caller's admin member: the FK is unconstrained across orgs in the
   * schema, and the cross-org weirdness is exactly the legacy data shape this
   * test is policing.
   */
  async function makeForeignOrgAgent(
    app: ReturnType<typeof getApp>,
    label: string,
    fallbackManagerId: string,
  ): Promise<{ orgId: string; agentUuid: string }> {
    const orgId = `org-${label}-${randomUUID().slice(0, 6)}`;
    await app.db.insert(organizations).values({
      id: orgId,
      name: orgId.slice(0, 30),
      displayName: `Org ${label}`,
    });
    const agentUuid = randomUUID();
    await app.db.insert(agents).values({
      uuid: agentUuid,
      name: `bot-${label}-${randomUUID().slice(0, 6)}`,
      organizationId: orgId,
      type: "autonomous_agent",
      displayName: `Bot ${label}`,
      inboxId: `inbox_${agentUuid}`,
      managerId: fallbackManagerId,
    });
    return { orgId, agentUuid };
  }

  it("A: findOrCreateDirectChat rejects cross-org agent pairs", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const other = await makeForeignOrgAgent(app, "b", admin.memberId);

    await expect(findOrCreateDirectChat(app.db, admin.humanAgentUuid, other.agentUuid)).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("A: does not reuse a historical cross-org chat that lists both ends as participants", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    // Two same-org agents in admin's org; both will (in a moment) appear as
    // participants of a dirty chat owned by a different org.
    const peerA = await createAgent(app.db, {
      name: `same-org-a-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Peer A",
      organizationId: admin.organizationId,
    });
    const peerB = await createAgent(app.db, {
      name: `same-org-b-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Peer B",
      organizationId: admin.organizationId,
    });

    // Simulate the legacy dirty state: a direct chat in a DIFFERENT org whose
    // chat_participants table contains both same-org agents (this is exactly
    // the pollution shape observed in production).
    const otherOrg = await makeForeignOrgAgent(app, "other", admin.memberId);
    const dirtyChatId = randomUUID();
    await app.db.insert(chats).values({
      id: dirtyChatId,
      organizationId: otherOrg.orgId,
      type: "direct",
    });
    await app.db.insert(chatMembership).values([
      { chatId: dirtyChatId, agentId: peerA.uuid, role: "member", accessMode: "speaker" },
      { chatId: dirtyChatId, agentId: peerB.uuid, role: "member", accessMode: "speaker" },
    ]);

    // Pre-fix behavior: returns the dirty chat. Post-fix: filters by
    // chats.organizationId and creates a fresh chat in admin's org.
    const chat = await findOrCreateDirectChat(app.db, peerA.uuid, peerB.uuid);
    expect(chat.id).not.toBe(dirtyChatId);
    expect(chat.organizationId).toBe(admin.organizationId);
  });

  it("C: listMeChats does not surface chats whose organization differs from the caller's", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    // Mint a foreign-org chat and splice the caller's human agent into its
    // participants table by raw INSERT — this mirrors the dirty data observed
    // in production (a path no current code can produce, but historical rows
    // still exist).
    const foreign = await makeForeignOrgAgent(app, "foreign", admin.memberId);
    const dirtyChatId = randomUUID();
    await app.db.insert(chats).values({
      id: dirtyChatId,
      organizationId: foreign.orgId,
      type: "direct",
    });
    await app.db.insert(chatMembership).values([
      { chatId: dirtyChatId, agentId: foreign.agentUuid, role: "member", accessMode: "speaker" },
      { chatId: dirtyChatId, agentId: admin.humanAgentUuid, role: "member", accessMode: "speaker" },
    ]);

    // Sanity check that the dirty row really would have leaked without the
    // org filter: the caller IS a participant.
    const [participantRow] = await app.db
      .select({ chatId: chatMembership.chatId })
      .from(chatMembership)
      .where(eq(chatMembership.agentId, admin.humanAgentUuid));
    expect(participantRow?.chatId).toBe(dirtyChatId);

    const res = await listMeChats(app.db, admin.humanAgentUuid, admin.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
    });
    expect(res.rows.find((r) => r.chatId === dirtyChatId)).toBeUndefined();
  });
});
