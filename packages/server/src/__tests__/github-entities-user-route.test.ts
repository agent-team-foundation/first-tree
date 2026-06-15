import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

/**
 * Class C (user-scoped) follow route: `POST /api/v1/chats/:chatId/github-entities`.
 *
 * The critical gate: the caller's `delegate_mention` agent must be an ACTIVE
 * SPEAKER of the chat before any mapping is written. GitHub delivery
 * addresses cards to the delegate and `sendMessage` only fans out to active
 * speakers — without the gate a "successful" follow would wire a line whose
 * events wake nobody (silently stored cards), violating the follow contract.
 */
describe("user github-entities follow route", () => {
  const getApp = useTestApp();

  async function seedAgent(app: App, orgId: string, memberId: string, type: "human" | "agent"): Promise<string> {
    const uuid = randomUUID();
    await app.db.insert(agents).values({
      uuid,
      name: `${type}-${uuid.slice(0, 8)}`,
      organizationId: orgId,
      type,
      displayName: type,
      inboxId: `inbox_${uuid}`,
      managerId: memberId,
      status: "active",
    });
    return uuid;
  }

  async function seedChat(app: App, orgId: string, participants: string[]): Promise<string> {
    const id = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id, organizationId: orgId, type: "group", metadata: {} });
    if (participants.length > 0) {
      await app.db.insert(chatMembership).values(
        participants.map((agentId, idx) => ({
          chatId: id,
          agentId,
          role: idx === 0 ? "owner" : "member",
          accessMode: "speaker" as const,
        })),
      );
    }
    return id;
  }

  function follow(app: App, accessToken: string, chatId: string, entity: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/github-entities`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { entity },
    });
  }

  it("rejects with guidance when the caller has no delegate_mention", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `u-${randomUUID().slice(0, 8)}` });
    const chatId = await seedChat(app, admin.organizationId, [admin.humanAgentUuid]);

    const res = await follow(app, admin.accessToken, chatId, "acme/api#42");
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("delegate_mention");
  });

  it("rejects when the delegate is not a speaker of the chat (no dead-line mapping)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `u-${randomUUID().slice(0, 8)}` });
    const delegate = await seedAgent(app, admin.organizationId, admin.memberId, "agent");
    await app.db.update(agents).set({ delegateMention: delegate }).where(eq(agents.uuid, admin.humanAgentUuid));
    // Chat does NOT include the delegate.
    const chatId = await seedChat(app, admin.organizationId, [admin.humanAgentUuid]);

    const res = await follow(app, admin.accessToken, chatId, "acme/api#42");
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("not an active speaker");
  });

  it("proceeds past the delegate gate once the delegate speaks in the chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `u-${randomUUID().slice(0, 8)}` });
    const delegate = await seedAgent(app, admin.organizationId, admin.memberId, "agent");
    await app.db.update(agents).set({ delegateMention: delegate }).where(eq(agents.uuid, admin.humanAgentUuid));
    const chatId = await seedChat(app, admin.organizationId, [admin.humanAgentUuid, delegate]);

    const res = await follow(app, admin.accessToken, chatId, "acme/api#42");
    // Past the pair gate, the request hits the installation gate (the test
    // org has no GitHub App) — proving the delegate validation admitted it.
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toContain("GitHub App");
  });
});
