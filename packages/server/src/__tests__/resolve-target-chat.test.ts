import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { GithubEntity } from "../api/webhooks/github-entity.js";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { resolveTargetChat as resolveTargetChatRaw } from "../services/github-entity-chat.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Test-only thin wrapper: every existing case in this file simulates the
 * mention path (none of them exercise the creation-event guard's null
 * branch). The wrapper defaults `isMentionMatched: true` so the legacy
 * assertions still compile after `isMentionMatched` became required, and
 * throws on null because that would be a real regression for these cases.
 */
async function resolveTargetChat(
  db: Parameters<typeof resolveTargetChatRaw>[0],
  params: Omit<Parameters<typeof resolveTargetChatRaw>[1], "isMentionMatched"> & {
    isMentionMatched?: boolean;
  },
): Promise<NonNullable<Awaited<ReturnType<typeof resolveTargetChatRaw>>>> {
  const result = await resolveTargetChatRaw(db, {
    ...params,
    isMentionMatched: params.isMentionMatched ?? true,
  });
  if (!result) throw new Error("resolveTargetChat returned null in legacy test path");
  return result;
}

async function seedDelegate(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  orgId: string,
  memberId: string,
  name: string,
): Promise<string> {
  const uuid = randomUUID();
  await app.db.insert(agents).values({
    uuid,
    name,
    organizationId: orgId,
    type: "agent",
    displayName: `Delegate ${name}`,
    inboxId: `inbox_${uuid}`,
    managerId: memberId,
  });
  return uuid;
}

const issue42: GithubEntity = {
  type: "issue",
  key: "owner/repo#42",
  title: "Refactor inbox",
  url: "https://github.com/owner/repo/issues/42",
};
const pr50: GithubEntity = {
  type: "pull_request",
  key: "owner/repo#50",
  title: "Implement refactor",
  url: "https://github.com/owner/repo/pull/50",
};
const issue43: GithubEntity = { type: "issue", key: "owner/repo#43", title: "Unrelated" };

describe("resolveTargetChat", () => {
  const getApp = useTestApp();

  it("creates a chat on first hit and writes a direct mapping", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedDelegate(app, admin.organizationId, admin.memberId, `dlg-${randomUUID().slice(0, 6)}`);

    const result = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: issue42,
      relatedEntities: [],
      eventType: "issues",
      action: "opened",
    });

    expect(result.created).toBe(true);
    expect(result.boundVia).toBe("direct");

    // Mapping row written with bound_via = direct.
    const mappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, result.chatId));
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.boundVia).toBe("direct");
    expect(mappings[0]?.entityType).toBe("issue");
    expect(mappings[0]?.entityKey).toBe("owner/repo#42");

    // Chat topic = formatEntityTitle(entity); metadata carries entity fields.
    const [chat] = await app.db.select().from(chats).where(eq(chats.id, result.chatId)).limit(1);
    expect(chat?.topic).toBe("Issue repo#42: Refactor inbox");
    expect(chat?.metadata).toMatchObject({
      source: "github",
      entityType: "issue",
      entityKey: "owner/repo#42",
      entityUrl: "https://github.com/owner/repo/issues/42",
    });
  });

  it("reuses the existing chat on a direct re-hit", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedDelegate(app, admin.organizationId, admin.memberId, `dlg-${randomUUID().slice(0, 6)}`);

    const first = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: issue42,
      relatedEntities: [],
      eventType: "issues",
      action: "opened",
    });
    const second = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: issue42,
      relatedEntities: [],
      eventType: "issues",
      action: "opened",
    });

    expect(second.chatId).toBe(first.chatId);
    expect(second.created).toBe(false);
    expect(second.boundVia).toBe("direct");

    const allChats = await app.db.select({ id: chats.id }).from(chats).where(eq(chats.id, first.chatId));
    expect(allChats).toHaveLength(1);
  });

  it("links a PR to the issue's chat via Fixes #N and writes a fixes_link mapping", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedDelegate(app, admin.organizationId, admin.memberId, `dlg-${randomUUID().slice(0, 6)}`);

    const issueResolved = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: issue42,
      relatedEntities: [],
      eventType: "issues",
      action: "opened",
    });
    const prResolved = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: pr50,
      relatedEntities: [issue42],
      eventType: "pull_request",
      action: "opened",
    });

    expect(prResolved.chatId).toBe(issueResolved.chatId);
    expect(prResolved.boundVia).toBe("fixes_link");

    const prMapping = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#50"));
    expect(prMapping).toHaveLength(1);
    expect(prMapping[0]?.boundVia).toBe("fixes_link");
  });

  it("does not link when no related entity has an existing mapping", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedDelegate(app, admin.organizationId, admin.memberId, `dlg-${randomUUID().slice(0, 6)}`);

    // PR references issue#43 but issue#43 has never been seen → new chat for PR.
    const prResolved = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: pr50,
      relatedEntities: [issue43],
      eventType: "pull_request",
      action: "opened",
    });

    expect(prResolved.created).toBe(true);
    expect(prResolved.boundVia).toBe("direct");
  });

  it("uses the first matching ref when multiple related entities have mappings", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedDelegate(app, admin.organizationId, admin.memberId, `dlg-${randomUUID().slice(0, 6)}`);

    // Seed both issue#42 and issue#43.
    const issue42Resolved = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: issue42,
      relatedEntities: [],
      eventType: "issues",
      action: "opened",
    });
    const issue43Resolved = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: issue43,
      relatedEntities: [],
      eventType: "issues",
      action: "opened",
    });
    expect(issue42Resolved.chatId).not.toBe(issue43Resolved.chatId);

    // PR with `Fixes #42 Fixes #43` — the first ref (issue#42) wins.
    const prResolved = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: pr50,
      relatedEntities: [issue42, issue43],
      eventType: "pull_request",
      action: "opened",
    });

    expect(prResolved.chatId).toBe(issue42Resolved.chatId);
    expect(prResolved.boundVia).toBe("fixes_link");
  });

  it("fan-outs to independent chats for two different humans on the same entity", async () => {
    const app = getApp();
    const adminA = await createTestAdmin(app);
    const adminB = await createTestAdmin(app);
    const delegateA = await seedDelegate(
      app,
      adminA.organizationId,
      adminA.memberId,
      `dlgA-${randomUUID().slice(0, 6)}`,
    );
    const delegateB = await seedDelegate(
      app,
      adminB.organizationId,
      adminB.memberId,
      `dlgB-${randomUUID().slice(0, 6)}`,
    );

    const resolvedA = await resolveTargetChat(app.db, {
      organizationId: adminA.organizationId,
      humanAgentId: adminA.humanAgentUuid,
      delegateAgentId: delegateA,
      entity: issue42,
      relatedEntities: [],
      eventType: "issues",
      action: "opened",
    });
    const resolvedB = await resolveTargetChat(app.db, {
      organizationId: adminB.organizationId,
      humanAgentId: adminB.humanAgentUuid,
      delegateAgentId: delegateB,
      entity: issue42,
      relatedEntities: [],
      eventType: "issues",
      action: "opened",
    });

    expect(resolvedA.chatId).not.toBe(resolvedB.chatId);
    expect(resolvedA.created).toBe(true);
    expect(resolvedB.created).toBe(true);
  });

  it("survives concurrent first-touch for the same (human, delegate, entity) tuple", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedDelegate(app, admin.organizationId, admin.memberId, `dlg-${randomUUID().slice(0, 6)}`);

    // Two near-simultaneous webhook deliveries. The mapping PK + ON CONFLICT
    // path ensures exactly one mapping row survives and both callers see the
    // same final chatId.
    const [r1, r2] = await Promise.all([
      resolveTargetChat(app.db, {
        organizationId: admin.organizationId,
        humanAgentId: admin.humanAgentUuid,
        delegateAgentId: delegate,
        entity: issue42,
        relatedEntities: [],
        eventType: "issues",
        action: "opened",
      }),
      resolveTargetChat(app.db, {
        organizationId: admin.organizationId,
        humanAgentId: admin.humanAgentUuid,
        delegateAgentId: delegate,
        entity: issue42,
        relatedEntities: [],
        eventType: "issues",
        action: "opened",
      }),
    ]);

    expect(r1.chatId).toBe(r2.chatId);

    const mappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, issue42.key));
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.chatId).toBe(r1.chatId);
  });

  it("renders 'PR Review' topic when a PR chat is first created by review_requested", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedDelegate(app, admin.organizationId, admin.memberId, `dlg-${randomUUID().slice(0, 6)}`);

    const resolved = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: pr50,
      relatedEntities: [],
      eventType: "pull_request",
      action: "review_requested",
    });

    const [chat] = await app.db.select().from(chats).where(eq(chats.id, resolved.chatId)).limit(1);
    expect(chat?.topic).toBe("PR Review repo#50: Implement refactor");
  });

  it("keeps the original topic when a follow-up event with a different prefix reuses the chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedDelegate(app, admin.organizationId, admin.memberId, `dlg-${randomUUID().slice(0, 6)}`);

    // PR chat first created by `pull_request.opened` → title prefix is "PR".
    const first = await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: pr50,
      relatedEntities: [],
      eventType: "pull_request",
      action: "opened",
    });
    // A later review-flow event for the same PR must NOT rewrite the title.
    await resolveTargetChat(app.db, {
      organizationId: admin.organizationId,
      humanAgentId: admin.humanAgentUuid,
      delegateAgentId: delegate,
      entity: pr50,
      relatedEntities: [],
      eventType: "pull_request_review",
      action: "submitted",
    });

    const [chat] = await app.db.select().from(chats).where(eq(chats.id, first.chatId)).limit(1);
    expect(chat?.topic).toBe("PR repo#50: Implement refactor");
  });
});
