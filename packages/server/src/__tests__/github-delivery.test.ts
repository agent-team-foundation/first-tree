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
import { type AudienceTarget, resolveAudience } from "../services/github-audience.js";
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
    type: "agent",
    displayName: opts.name,
    inboxId: `inbox_${uuid}`,
    managerId: opts.memberId,
    delegateMention: opts.delegateMention ?? null,
    // Match `services/agent.ts::defaultVisibility` — an `autonomous_agent`
    // created via the service layer is `organization`-visible. The raw
    // INSERT here was implicitly relying on the column default ("private")
    // which made these fixtures private agents, which in turn relied on
    // the now-tightened owner-exclusive rule's lenient (shared-managerId)
    // reading to admit them as participants. Pinning visibility here
    // makes the fixture mirror prod reality.
    visibility: "organization",
  });
  return uuid;
}

function makeEvent(opts: {
  orgId: string;
  entityType: "issue" | "pull_request";
  entityKey: string;
  involves?: NormalizedEvent["involves"];
  body?: string;
  rawEventType?: string;
  rawAction?: string;
  title?: string;
  actorLogin?: string;
}): NormalizedEvent {
  return {
    source: { kind: "github-app-installation", installationId: 1, organizationId: opts.orgId },
    deliveryId: "delivery-1",
    rawEventType: opts.rawEventType ?? "pull_request",
    rawAction: opts.rawAction ?? "opened",
    entity: {
      type: opts.entityType,
      repo: "owner/repo",
      key: opts.entityKey,
      title: opts.title ?? "Refactor inbox",
      url: `https://github.com/owner/repo/pull/1`,
    },
    actor: { githubLogin: opts.actorLogin ?? "alice", isBot: false },
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
      actorAgentId: null,
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

  it("delivers a recipientless card when the delegate is not a live speaker (trusted opt-out, wakes no one)", async () => {
    // Empty-addressing system path: github-delivery addresses the delegate via
    // `addressedToAgentIds`, but on some events that delegate is not an active
    // speaker of the bound chat, so the addressing resolves to no live
    // recipient. The default explicit-recipient guard would reject such a send;
    // github-delivery declares `allowRecipientlessSend` so the card still lands
    // as a history/context row for human observers. This pins that the trusted
    // opt-out is load-bearing — the delivery must NOT throw and must wake no one.
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

    // Bind a chat for the entity, but make ONLY the human a speaker — the
    // delegate is deliberately not a member, so the card's addressing resolves
    // to no live speaker.
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "direct" });
    await app.db.insert(chatMembership).values({
      chatId,
      agentId: human,
      role: "owner",
      accessMode: "speaker",
      mode: "full",
      source: "manual",
    });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#201",
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
      actorAgentId: null,
    };
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#201",
    });

    const stats = await deliverNormalizedEvent(app, event, [target]);

    // Delivery succeeds (no throw despite recipientless addressing).
    expect(stats).toEqual({ delivered: 1, newChats: 0, failed: 0 });
    const sent = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.format).toBe("card");
    // Wakes no one: the delegate has no inbox row at all (not a participant),
    // so nothing was fanned out / notified.
    const delegateEntries = await app.db
      .select()
      .from(inboxEntries)
      .where(and(eq(inboxEntries.chatId, chatId), eq(inboxEntries.notify, true)));
    expect(delegateEntries).toHaveLength(0);
  });

  it("echo (#942): excludes the actor from addressing — card still written, actor not woken", async () => {
    // The delegate is a live speaker of the bound chat, so it would normally
    // be woken. When the delegate is ALSO the event's actor (its own GitHub
    // action, surfaced as `target.actorAgentId`), #942 excludes it from
    // `addressedToAgentIds`: the card still lands (public record) but the
    // actor is not woken / red-dotted. With `actorAgentId = null` the same
    // speaker-delegate IS woken — the two deliveries below pin both sides.
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
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
    await app.db.insert(chatMembership).values([
      { chatId, agentId: human, role: "owner", accessMode: "speaker", mode: "full", source: "manual" },
      { chatId, agentId: delegate, role: "member", accessMode: "speaker", mode: "full", source: "manual" },
    ]);
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#205",
      chatId,
      boundVia: "direct",
    });
    const baseTarget = {
      humanAgentId: human,
      delegateAgentId: delegate,
      kind: "existing",
      chatId,
      involveReason: null,
      involveLogin: null,
    } satisfies Omit<AudienceTarget, "actorAgentId">;
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#205",
    });

    // (1) actor === delegate: excluded from addressing → card written, no wake.
    const echoStats = await deliverNormalizedEvent(app, event, [{ ...baseTarget, actorAgentId: delegate }]);
    expect(echoStats.delivered).toBe(1);
    const afterEcho = await app.db
      .select()
      .from(inboxEntries)
      .where(and(eq(inboxEntries.chatId, chatId), eq(inboxEntries.notify, true)));
    expect(afterEcho).toHaveLength(0);

    // (2) actor !== delegate (null): the speaker-delegate IS woken.
    const okStats = await deliverNormalizedEvent(app, event, [{ ...baseTarget, actorAgentId: null }]);
    expect(okStats.delivered).toBe(1);
    const afterOk = await app.db
      .select()
      .from(inboxEntries)
      .where(and(eq(inboxEntries.chatId, chatId), eq(inboxEntries.notify, true)));
    expect(afterOk.length).toBeGreaterThan(0);
  });

  it("refreshes chats.topic to match the current entity title on each subsequent event for a github-bound chat", async () => {
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

    // Seed an existing github-bound chat with a stale topic (e.g. PR title
    // was different when the chat was minted).
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: chatId,
      organizationId: admin.organizationId,
      type: "direct",
      topic: "PR repo#200: Old title from creation",
    });
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
      actorAgentId: null,
    };
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#200",
    });
    await deliverNormalizedEvent(app, event, [target]);

    const [row] = await app.db.select({ topic: chats.topic }).from(chats).where(eq(chats.id, chatId)).limit(1);
    expect(row?.topic).toBe("PR repo#200: Refactor inbox");
  });

  it("preserves the original prefix on a review-flow event (no PR → PR Review drift)", async () => {
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

    // Chat was minted from `pull_request.opened` → head is the plain "PR"
    // prefix. A later review event must update the title but keep "PR" — it
    // must NOT promote the head to "PR Review".
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: chatId,
      organizationId: admin.organizationId,
      type: "direct",
      topic: "PR repo#200: Old title",
    });
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
      actorAgentId: null,
    };
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#200",
      rawEventType: "pull_request_review",
      rawAction: "submitted",
      title: "Renamed title",
    });
    await deliverNormalizedEvent(app, event, [target]);

    const [row] = await app.db.select({ topic: chats.topic }).from(chats).where(eq(chats.id, chatId)).limit(1);
    expect(row?.topic).toBe("PR repo#200: Renamed title");
  });

  it("does NOT overwrite the owning topic when a linked (fixes_link) entity's event arrives", async () => {
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

    // Chat was minted for issue#42 (its direct anchor + topic). A PR#99 that
    // `Fixes #42` later got a `fixes_link` mapping row pointing at the same
    // chat. An event for PR#99 must NOT hijack the chat's issue topic.
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: chatId,
      organizationId: admin.organizationId,
      type: "direct",
      topic: "Issue repo#42: Login bug",
    });
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "issue",
        entityKey: "owner/repo#42",
        chatId,
        boundVia: "direct",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        entityType: "pull_request",
        entityKey: "owner/repo#99",
        chatId,
        boundVia: "fixes_link",
      },
    ]);

    const target: AudienceTarget = {
      humanAgentId: human,
      delegateAgentId: delegate,
      kind: "existing",
      chatId,
      involveReason: null,
      involveLogin: null,
      actorAgentId: null,
    };
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#99",
      title: "Fix the login bug",
    });
    await deliverNormalizedEvent(app, event, [target]);

    const [row] = await app.db.select({ topic: chats.topic }).from(chats).where(eq(chats.id, chatId)).limit(1);
    expect(row?.topic).toBe("Issue repo#42: Login bug");
  });

  it("does NOT touch chats.topic for chats without a github entity mapping (manual / agent-set topic is preserved)", async () => {
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

    // A chat that the agent renamed to a custom label — no mapping row.
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: chatId,
      organizationId: admin.organizationId,
      type: "direct",
      topic: "agent-chosen label",
    });

    const target: AudienceTarget = {
      humanAgentId: human,
      delegateAgentId: delegate,
      kind: "existing",
      chatId,
      involveReason: null,
      involveLogin: null,
      actorAgentId: null,
    };
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#999",
    });
    await deliverNormalizedEvent(app, event, [target]);

    const [row] = await app.db.select({ topic: chats.topic }).from(chats).where(eq(chats.id, chatId)).limit(1);
    expect(row?.topic).toBe("agent-chosen label");
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
      actorAgentId: null,
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
      actorAgentId: null,
    };
    const ok: AudienceTarget = {
      humanAgentId: goodHuman,
      delegateAgentId: delegate,
      kind: "existing",
      chatId: goodChatId,
      involveReason: null,
      involveLogin: null,
      actorAgentId: null,
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
      actorAgentId: null,
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

  it("M2 + echo combined: actor is the represented human, entity bound from two chats — both wake their delegate (regression)", async () => {
    // Single fixture that lights up BOTH old defects at once — the exact shape
    // of the multi-human-not-pushed bug, which only manifests when they stack:
    //   - old M2 (dedup by `humanAgentId`, keep earliest) dropped the LATER
    //     chat (chatB) — bound_at order is load-bearing;
    //   - old echo (actor on the human side → drop the whole row) then dropped
    //     chatA too, since the actor IS chatA's represented human.
    // Old code → empty audience → both chats silent. This pins the fix end to
    // end: drives `resolveAudience` → `deliverNormalizedEvent` and asserts both
    // chats not only re-enter the audience but each delegate (≠ actor) is
    // actually woken — a pure audience-layer assertion cannot prove the wake.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const humanName = `rep-human-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
    });
    const da = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-a-${randomUUID().slice(0, 6)}`,
    });
    const db = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-b-${randomUUID().slice(0, 6)}`,
    });

    const chatA = `chat_${randomUUID()}`;
    const chatB = `chat_${randomUUID()}`;
    await app.db.insert(chats).values([
      { id: chatA, organizationId: admin.organizationId, type: "group" },
      { id: chatB, organizationId: admin.organizationId, type: "group" },
    ]);
    // H speaks in both; each chat's delegate is a speaker so it can be woken.
    await app.db.insert(chatMembership).values([
      { chatId: chatA, agentId: human, role: "owner", accessMode: "speaker", mode: "full", source: "manual" },
      { chatId: chatA, agentId: da, role: "member", accessMode: "speaker", mode: "full", source: "manual" },
      { chatId: chatB, agentId: human, role: "owner", accessMode: "speaker", mode: "full", source: "manual" },
      { chatId: chatB, agentId: db, role: "member", accessMode: "speaker", mode: "full", source: "manual" },
    ]);
    // chatA bound EARLIER, chatB LATER — old dedup-by-human kept chatA, dropped chatB.
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: da,
        entityType: "pull_request",
        entityKey: "owner/repo#777",
        chatId: chatA,
        boundVia: "human_fallback",
        boundAt: new Date(Date.now() - 60_000),
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: db,
        entityType: "pull_request",
        entityKey: "owner/repo#777",
        chatId: chatB,
        boundVia: "agent_declared",
        boundAt: new Date(),
      },
    ]);

    // `synchronize` (not `opened`) so the #766 opened-card carve-out cannot interfere.
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#777",
      actorLogin: humanName,
      rawAction: "synchronize",
    });

    // Stage 2: both chats survive. M2 keeps the (human, chat) pairs distinct;
    // echo annotates `actorAgentId = H` on every row instead of dropping any.
    const audience = await resolveAudience(app.db, event, "first-tree");
    expect(audience).toHaveLength(2);
    expect(new Set(audience.map((a) => a.chatId))).toEqual(new Set([chatA, chatB]));
    for (const target of audience) expect(target.actorAgentId).toBe(human);

    // Stage 3: both cards land AND each chat's delegate (≠ actor) is woken.
    const stats = await deliverNormalizedEvent(app, event, audience);
    expect(stats.delivered).toBe(2);

    const [daRow] = await app.db.select({ inboxId: agents.inboxId }).from(agents).where(eq(agents.uuid, da)).limit(1);
    const [dbRow] = await app.db.select({ inboxId: agents.inboxId }).from(agents).where(eq(agents.uuid, db)).limit(1);
    const [hRow] = await app.db.select({ inboxId: agents.inboxId }).from(agents).where(eq(agents.uuid, human)).limit(1);

    // chatA: card written + Da woken.
    expect(await app.db.select().from(messages).where(eq(messages.chatId, chatA))).toHaveLength(1);
    const daWoken = await app.db
      .select()
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.chatId, chatA),
          eq(inboxEntries.notify, true),
          eq(inboxEntries.inboxId, daRow?.inboxId ?? ""),
        ),
      );
    expect(daWoken.length).toBeGreaterThan(0);

    // chatB: card written + Db woken — chatB is the chat the OLD dedup silently dropped.
    expect(await app.db.select().from(messages).where(eq(messages.chatId, chatB))).toHaveLength(1);
    const dbWoken = await app.db
      .select()
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.chatId, chatB),
          eq(inboxEntries.notify, true),
          eq(inboxEntries.inboxId, dbRow?.inboxId ?? ""),
        ),
      );
    expect(dbWoken.length).toBeGreaterThan(0);

    // The actor (== represented human H) is never woken by its own action.
    const hWoken = await app.db
      .select()
      .from(inboxEntries)
      .where(and(eq(inboxEntries.notify, true), eq(inboxEntries.inboxId, hRow?.inboxId ?? "")));
    expect(hWoken).toHaveLength(0);
  });
});
