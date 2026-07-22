import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { organizations } from "../db/schema/organizations.js";
import { listMeChats } from "../services/me-chat.js";
import { createTestAdmin, TEST_AVATAR_AUTHORITY_TAG, useTestApp } from "./helpers.js";

/**
 * Regression coverage for cross-org chat pollution at the read layer.
 *
 * The original write-side `findOrCreateDirectChat` pollution guards were
 * removed alongside the function itself (see
 * first-tree-context PR #281). The remaining concern is purely
 * defensive: legacy dirty rows whose `organization_id` disagrees with a
 * participant's must never leak into a user's chat list, regardless of
 * what bug originally produced them.
 */
describe("cross-org chat pollution — read-side guard rails", () => {
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
      type: "agent",
      displayName: `Bot ${label}`,
      inboxId: `inbox_${agentUuid}`,
      managerId: fallbackManagerId,
    });
    return { orgId, agentUuid };
  }

  it("listMeChats does not surface chats whose organization differs from the caller's", async () => {
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

    const res = await listMeChats(
      app.db,
      admin.humanAgentUuid,
      admin.memberId,
      admin.organizationId,
      {
        limit: 50,
        filter: "all",
        engagement: "all",
      },
      TEST_AVATAR_AUTHORITY_TAG,
    );
    expect(res.rows.find((r) => r.chatId === dirtyChatId)).toBeUndefined();
  });
});
