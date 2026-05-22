import { randomUUID } from "node:crypto";
import type { NormalizedEvent } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import type { AudienceTarget } from "../services/github-audience.js";
import { deliverNormalizedEvent } from "../services/github-delivery.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

async function seedAgent(
  app: App,
  opts: {
    orgId: string;
    memberId: string;
    name: string;
    delegateMention?: string | null;
  },
): Promise<string> {
  const uuid = randomUUID();
  await app.db.insert(agents).values({
    uuid,
    name: opts.name,
    organizationId: opts.orgId,
    type: "autonomous_agent",
    displayName: opts.name,
    inboxId: `inbox_${uuid}`,
    managerId: opts.memberId,
    delegateMention: opts.delegateMention ?? null,
  });
  return uuid;
}

function makeEvent(opts: {
  orgId: string;
  entityType: "issue" | "pull_request";
  entityKey: string;
  involves?: NormalizedEvent["involves"];
  body?: string;
}): NormalizedEvent {
  return {
    source: { kind: "github-app-installation", installationId: 1, organizationId: opts.orgId },
    deliveryId: "delivery-1",
    rawEventType: "pull_request",
    rawAction: "opened",
    entity: {
      type: opts.entityType,
      repo: "owner/repo",
      key: opts.entityKey,
      title: "Refactor inbox",
      url: `https://github.com/owner/repo/pull/1`,
    },
    actor: { githubLogin: "alice", isBot: false },
    kind: "opened",
    involves: opts.involves ?? [],
    surface: {
      title: "PR #1: Refactor inbox",
      body: opts.body ?? "",
      url: "https://github.com/owner/repo/pull/1",
    },
    relatedRefs: [],
  };
}

describe("deliverNormalizedEvent", () => {
  const getApp = useTestApp();

  it("delivers to an existing target without creating a new chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
    });

    // Seed an existing chat + mapping for the target entity
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#200",
      chatId,
      boundVia: "direct",
    });

    const target: AudienceTarget = {
      humanAgentId: human,
      delegateAgentId: delegate,
      kind: "existing",
      chatId,
      involveReason: null,
      involveLogin: null,
    };
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#200",
    });
    const stats = await deliverNormalizedEvent(app, event, [target]);

    expect(stats).toEqual({ delivered: 1, newChats: 0, failed: 0 });
    const sent = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.format).toBe("card");
    const content = sent[0]?.content as { type: string; reason: string };
    expect(content.type).toBe("github_event");
    expect(content.reason).toBe("subscribed");
  });

  it("creates a fresh chat + mapping for a `new` target, card.reason matches involveReason, mentionedUser populated", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `bob-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
    });

    const target: AudienceTarget = {
      humanAgentId: human,
      delegateAgentId: delegate,
      kind: "new",
      chatId: null,
      involveReason: "review_requested",
      involveLogin: humanName.toLowerCase(),
    };
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#201",
      involves: [{ githubLogin: humanName, reason: "review_requested" }],
    });
    const stats = await deliverNormalizedEvent(app, event, [target]);

    expect(stats).toEqual({ delivered: 1, newChats: 1, failed: 0 });

    // A new mapping row exists pointing at a chat row
    const [mapping] = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(
        and(
          eq(githubEntityChatMappings.organizationId, admin.organizationId),
          eq(githubEntityChatMappings.entityKey, "owner/repo#201"),
        ),
      );
    expect(mapping).toBeTruthy();
    expect(mapping?.boundVia).toBe("direct");

    const [chatRow] = await app.db
      .select()
      .from(chats)
      .where(eq(chats.id, mapping?.chatId ?? ""))
      .limit(1);
    expect(chatRow?.organizationId).toBe(admin.organizationId);

    const sent = await app.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatRow?.id ?? ""));
    expect(sent).toHaveLength(1);
    const content = sent[0]?.content as { reason: string; mentionedUser?: string };
    expect(content.reason).toBe("review_requested");
    expect(content.mentionedUser).toBe(humanName.toLowerCase());
  });

  it("isolates per-target failures — second target succeeds even if first throws", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const goodHuman = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-good-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
    });
    const goodChatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: goodChatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: goodHuman,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#202",
      chatId: goodChatId,
      boundVia: "direct",
    });

    const broken: AudienceTarget = {
      humanAgentId: goodHuman,
      delegateAgentId: delegate,
      kind: "existing",
      chatId: null, // forces the runtime guard to throw
      involveReason: null,
      involveLogin: null,
    };
    const ok: AudienceTarget = {
      humanAgentId: goodHuman,
      delegateAgentId: delegate,
      kind: "existing",
      chatId: goodChatId,
      involveReason: null,
      involveLogin: null,
    };
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#202",
    });

    const stats = await deliverNormalizedEvent(app, event, [broken, ok]);
    expect(stats.delivered).toBe(1);
    // M1 (#507): the broken target's exception must be counted, not
    // silently swallowed by the per-target catch — operators dashboard
    // off this counter to spot regressions in single-target reliability.
    expect(stats.failed).toBe(1);
    const sent = await app.db.select().from(messages).where(eq(messages.chatId, goodChatId));
    expect(sent).toHaveLength(1);
  });

  // Regression: a GitHub-bound chat that has been expanded to >=3 speakers
  // (e.g. a teammate invited in) must still wake the delegate agent that
  // owns the entity. Before the fix, github-delivery passed neither
  // `addressedToAgentIds` nor `metadata.mentions`, so for card-format
  // messages in a multi-speaker chat the fan-out collapsed to
  // `notify=false` for everyone and the agent never woke.
  it("wakes the delegate even in a multi-speaker bound chat (no mention required)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
    });
    const watcher = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `watcher-${randomUUID().slice(0, 6)}`,
    });

    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
    await app.db.insert(chatMembership).values([
      { chatId, agentId: human, role: "owner", accessMode: "speaker" },
      { chatId, agentId: delegate, role: "member", accessMode: "speaker" },
      { chatId, agentId: watcher, role: "member", accessMode: "speaker" },
    ]);
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#900",
      chatId,
      boundVia: "direct",
    });

    const target: AudienceTarget = {
      humanAgentId: human,
      delegateAgentId: delegate,
      kind: "existing",
      chatId,
      involveReason: null,
      involveLogin: null,
    };
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#900",
    });
    const stats = await deliverNormalizedEvent(app, event, [target]);
    expect(stats).toEqual({ delivered: 1, newChats: 0, failed: 0 });

    const [delegateAgent] = await app.db
      .select({ inboxId: agents.inboxId })
      .from(agents)
      .where(eq(agents.uuid, delegate))
      .limit(1);
    const [watcherAgent] = await app.db
      .select({ inboxId: agents.inboxId })
      .from(agents)
      .where(eq(agents.uuid, watcher))
      .limit(1);

    const rows = await app.db.select().from(inboxEntries).where(eq(inboxEntries.chatId, chatId));
    const delegateRow = rows.find((r) => r.inboxId === delegateAgent?.inboxId);
    const watcherRow = rows.find((r) => r.inboxId === watcherAgent?.inboxId);

    // The delegate is the structural target of the audience row — must wake.
    expect(delegateRow?.notify).toBe(true);
    // Other group speakers stay silent (history-only) — exactly the
    // mention-only behaviour for unaddressed participants.
    expect(watcherRow?.notify).toBe(false);
  });
});
