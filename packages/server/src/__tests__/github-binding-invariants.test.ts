import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { GithubEntity } from "../api/webhooks/github-entity.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { organizations } from "../db/schema/organizations.js";
import { resolveBindingPair, resolveTargetChat } from "../services/github-entity-chat.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

/**
 * Invariants of the shared binding scaffolding that survived the auto-binder
 * removal and now back the explicit `github follow` paths:
 *
 *   - the creation-event guard in `resolveTargetChat` (B5: opened webhooks
 *     must not invent chats for non-mentioned targets) — with the auto-binder
 *     gone, the window between entity creation and the explicit follow is the
 *     guard's main protection against chat proliferation;
 *   - `resolveBindingPair` selection rules (B4: delegateMention-linked human
 *     first, id-sorted fallback, single representative) and the cross-org
 *     refusal — now the pairing engine for the agent follow route.
 *
 * These cases previously lived in the deleted auto-binder test suite; the
 * behaviors they lock are still live.
 */
describe("github binding invariants", () => {
  const getApp = useTestApp();

  async function seedAgent(
    app: App,
    opts: { orgId: string; memberId: string; type: "human" | "agent"; status?: "active" | "suspended" },
  ): Promise<string> {
    const uuid = randomUUID();
    await app.db.insert(agents).values({
      uuid,
      name: `${opts.type}-${uuid.slice(0, 8)}`,
      organizationId: opts.orgId,
      type: opts.type,
      displayName: opts.type,
      inboxId: `inbox_${uuid}`,
      managerId: opts.memberId,
      status: opts.status ?? "active",
    });
    return uuid;
  }

  async function seedChat(app: App, orgId: string, participants: string[]): Promise<string> {
    const id = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id, organizationId: orgId, type: "group", metadata: {} });
    await app.db.insert(chatMembership).values(
      participants.map((agentId, idx) => ({
        chatId: id,
        agentId,
        role: idx === 0 ? "owner" : "member",
        accessMode: "speaker" as const,
      })),
    );
    return id;
  }

  function entity(): GithubEntity {
    return {
      type: "pull_request",
      key: `owner/repo#${Math.floor(Math.random() * 100000)}`,
      url: "https://github.com/owner/repo/pull/1",
    };
  }

  describe("creation-event guard (resolveTargetChat)", () => {
    it("returns null on an opened PR webhook when no mapping exists and target is not mention-driven", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const delegate = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId, type: "agent" });

      const result = await resolveTargetChat(app.db, {
        organizationId: admin.organizationId,
        humanAgentId: admin.humanAgentUuid,
        delegateAgentId: delegate,
        entity: entity(),
        relatedEntities: [],
        eventType: "pull_request",
        action: "opened",
        isMentionMatched: false,
      });

      expect(result).toBeNull();
      const mappings = await app.db.select().from(githubEntityChatMappings);
      expect(
        mappings.filter((m) => m.humanAgentId === admin.humanAgentUuid && m.delegateAgentId === delegate),
      ).toHaveLength(0);
    });

    it("still creates the chat when the target IS mention-driven", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const delegate = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId, type: "agent" });

      const result = await resolveTargetChat(app.db, {
        organizationId: admin.organizationId,
        humanAgentId: admin.humanAgentUuid,
        delegateAgentId: delegate,
        entity: entity(),
        relatedEntities: [],
        eventType: "pull_request",
        action: "opened",
        isMentionMatched: true,
      });

      expect(result).not.toBeNull();
      expect(result?.created).toBe(true);
      expect(result?.boundVia).toBe("direct");
    });

    it("non-creation events never trigger the guard", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const delegate = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId, type: "agent" });

      const result = await resolveTargetChat(app.db, {
        organizationId: admin.organizationId,
        humanAgentId: admin.humanAgentUuid,
        delegateAgentId: delegate,
        entity: entity(),
        relatedEntities: [],
        eventType: "issue_comment",
        action: "created",
        isMentionMatched: false,
      });

      expect(result).not.toBeNull();
      expect(result?.created).toBe(true);
    });
  });

  describe("resolveBindingPair", () => {
    it("prefers a human whose delegateMention points at the caller over id-sorted-first", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const delegate = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId, type: "agent" });

      const humanA = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId, type: "human" });
      const humanB = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId, type: "human" });
      // Link the LARGER-sorting human so id-sorted-first would pick the other.
      const [, largerHuman] = humanA < humanB ? [humanA, humanB] : [humanB, humanA];
      await app.db.update(agents).set({ delegateMention: delegate }).where(eq(agents.uuid, largerHuman));

      const chatId = await seedChat(app, admin.organizationId, [humanA, humanB, delegate]);
      const pair = await resolveBindingPair(app.db, chatId, delegate);

      expect(pair).not.toBeNull();
      expect(pair?.humanAgentId).toBe(largerHuman);
      expect(pair?.delegateAgentId).toBe(delegate);
    });

    it("rejects an ambiguous owner when no delegateMention links the caller", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const delegate = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId, type: "agent" });
      const humanA = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId, type: "human" });
      const humanB = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId, type: "human" });
      const chatId = await seedChat(app, admin.organizationId, [humanA, humanB, delegate]);
      const pair = await resolveBindingPair(app.db, chatId, delegate);

      expect(pair).toBeNull();
    });

    it("returns null when the caller is not a chat member, or is itself human", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const delegate = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId, type: "agent" });
      const human = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId, type: "human" });
      const chatId = await seedChat(app, admin.organizationId, [human]);

      // Non-member caller.
      await expect(resolveBindingPair(app.db, chatId, delegate)).resolves.toBeNull();
      // Human caller.
      await expect(resolveBindingPair(app.db, chatId, human)).resolves.toBeNull();
    });

    it("refuses the binding when the caller's org differs from the chat's org (#508)", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app, { username: `u-${randomUUID().slice(0, 8)}` });
      // `createTestAdmin` reuses one fixed test org — seed a genuinely
      // foreign org directly so the cross-org guard has something to refuse.
      const foreignOrgId = randomUUID();
      await app.db.insert(organizations).values({
        id: foreignOrgId,
        name: `org-${foreignOrgId.slice(0, 8)}`,
        displayName: "Foreign Org",
      });
      // Delegate lives in the foreign org but is (grandfathered) a member of
      // the chat's org.
      const foreignDelegate = await seedAgent(app, {
        orgId: foreignOrgId,
        memberId: admin.memberId,
        type: "agent",
      });
      const human = await seedAgent(app, { orgId: admin.organizationId, memberId: admin.memberId, type: "human" });
      const chatId = await seedChat(app, admin.organizationId, [human, foreignDelegate]);

      await expect(resolveBindingPair(app.db, chatId, foreignDelegate)).resolves.toBeNull();
    });
  });
});
