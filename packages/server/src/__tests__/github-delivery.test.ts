import { randomUUID } from "node:crypto";
import type { NormalizedScmEvent } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { users } from "../db/schema/users.js";
import { type AudienceTarget, resolveGithubAudience } from "../services/github-audience.js";
import { deliverGithubEvent } from "../services/github-delivery.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

async function seedAgent(
  app: App,
  opts: {
    orgId: string;
    memberId: string;
    name: string;
    type?: "agent" | "human";
    delegateMention?: string | null;
  },
): Promise<string> {
  const uuid = randomUUID();
  const managerId = opts.type === "human" ? randomUUID() : opts.memberId;
  if (opts.type === "human") {
    const userId = randomUUID();
    await app.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: `user-${uuid}`,
        passwordHash: "test",
        displayName: opts.name,
      });
      await tx.insert(agents).values({
        uuid,
        name: opts.name,
        organizationId: opts.orgId,
        type: "human",
        displayName: opts.name,
        inboxId: `inbox_${uuid}`,
        managerId,
        delegateMention: opts.delegateMention ?? null,
        visibility: "organization",
      });
      await tx.insert(members).values({
        id: managerId,
        userId,
        organizationId: opts.orgId,
        agentId: uuid,
        role: "member",
      });
    });
    return uuid;
  }
  await app.db.insert(agents).values({
    uuid,
    name: opts.name,
    organizationId: opts.orgId,
    type: "agent",
    displayName: opts.name,
    inboxId: `inbox_${uuid}`,
    managerId,
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
  targets?: NormalizedScmEvent["targets"];
  body?: string;
  eventType?: string;
  action?: string;
  kind?: NormalizedScmEvent["kind"];
  title?: string;
  actorLogin?: string;
}): NormalizedScmEvent {
  return {
    provider: "github",
    source: { externalId: "installation:1", organizationId: opts.orgId },
    stableDeliveryId: "delivery-1",
    ingressAuthority: "verified_signature",
    eventType: opts.eventType ?? "pull_request",
    action: opts.action ?? "opened",
    entity: {
      type: opts.entityType,
      projectKey: "owner/repo",
      key: opts.entityKey,
      title: opts.title ?? "Refactor inbox",
      url: `https://github.com/owner/repo/pull/1`,
    },
    actor: { externalUsername: opts.actorLogin ?? "alice", isBot: false },
    kind: opts.kind ?? "opened",
    targets: opts.targets ?? [],
    surface: {
      title: "PR #1: Refactor inbox",
      body: opts.body ?? "",
      url: "https://github.com/owner/repo/pull/1",
    },
    relatedRefs: [],
  };
}

async function notifyCount(app: App, chatId: string, agentId: string): Promise<number> {
  const [agent] = await app.db
    .select({ inboxId: agents.inboxId })
    .from(agents)
    .where(eq(agents.uuid, agentId))
    .limit(1);
  const rows = await app.db
    .select({ id: inboxEntries.messageId })
    .from(inboxEntries)
    .where(
      and(
        eq(inboxEntries.inboxId, agent?.inboxId ?? ""),
        eq(inboxEntries.chatId, chatId),
        eq(inboxEntries.notify, true),
      ),
    );
  return rows.length;
}

describe("deliverGithubEvent", () => {
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
      type: "human",
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
    const stats = await deliverGithubEvent(app, event, [target]);

    expect(stats).toEqual({ delivered: 1, newChats: 0, failed: 0 });
    const sent = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.format).toBe("card");
    const content = sent[0]?.content as { type: string; reason: string };
    expect(content.type).toBe("github_event");
    expect(content.reason).toBe("subscribed");
  });

  it("delivers a recipientless card when the delegate is not a live speaker (trusted opt-out, wakes no one)", async () => {
    // Empty-wake-set system path: github-delivery wakes the delegate via native
    // `metadata.mentions`, but on some events that delegate is not an active
    // speaker of the bound chat, so the mention is filtered out and the wake-set
    // resolves to no live recipient. The default explicit-recipient guard would
    // reject such a send; github-delivery declares `allowRecipientlessSend` so
    // the card still lands as a history/context row for human observers. This
    // pins that the trusted opt-out is load-bearing — the delivery must NOT
    // throw and must wake no one.
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
      type: "human",
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
    };
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#201",
    });

    const stats = await deliverGithubEvent(app, event, [target]);

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

  it("echo pruning: drops a self-only delivery before writing a card", async () => {
    // The delegate is a live speaker of the bound chat, so an unresolved actor
    // would normally wake it. When the GitHub actor resolves to the same human
    // that owns this mapping, delivery prunes that entry before send: no card,
    // no inbox row, and no wake.
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
      type: "human",
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
    } satisfies AudienceTarget;
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#205",
    });

    const echoStats = await deliverGithubEvent(app, event, [baseTarget], { actorHumanId: human });
    expect(echoStats).toEqual({ delivered: 0, newChats: 0, failed: 0 });
    await expect(app.db.select().from(messages).where(eq(messages.chatId, chatId))).resolves.toHaveLength(0);
    await expect(app.db.select().from(inboxEntries).where(eq(inboxEntries.chatId, chatId))).resolves.toHaveLength(0);

    // Unknown actor: no self pruning, so the speaker-delegate IS woken.
    const okStats = await deliverGithubEvent(app, event, [baseTarget], { actorHumanId: null });
    expect(okStats.delivered).toBe(1);
    const afterOk = await app.db
      .select()
      .from(inboxEntries)
      .where(and(eq(inboxEntries.chatId, chatId), eq(inboxEntries.notify, true)));
    expect(afterOk.length).toBeGreaterThan(0);
  });

  it("self-echo carve-out: a fresh self-assigned issue mints a tracking chat (#1536)", async () => {
    // Regression for #1536. When the actor self-assigns / self-@s a brand-new
    // entity, the sole audience target is the actor's own (human, delegate)
    // pair with `kind: "new"`. The old blanket self-echo prune dropped it, so
    // no chat was ever created and the entity stayed invisible to First Tree.
    // A fresh directed involve must survive the prune and mint the chat.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `human-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });
    const entityKey = "owner/repo#1536";
    const target = {
      humanAgentId: human,
      delegateAgentId: delegate,
      kind: "new",
      chatId: null,
      involveReason: "assigned",
      involveLogin: humanName.toLowerCase(),
    } satisfies AudienceTarget;
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "issue",
      entityKey,
      eventType: "issues",
      action: "opened",
      kind: "opened",
      actorLogin: humanName,
      targets: [{ externalUsername: humanName.toLowerCase(), reason: "assigned" }],
    });

    // Actor resolves to the same human that self-assigned — the exact echo
    // condition — yet the fresh directed involve survives and mints a chat.
    const stats = await deliverGithubEvent(app, event, [target], { actorHumanId: human });
    expect(stats).toEqual({ delivered: 1, newChats: 1, failed: 0 });

    const mapping = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(
        and(
          eq(githubEntityChatMappings.organizationId, admin.organizationId),
          eq(githubEntityChatMappings.entityType, "issue"),
          eq(githubEntityChatMappings.entityKey, entityKey),
        ),
      );
    expect(mapping).toHaveLength(1);
    const chatId = mapping[0]?.chatId;
    expect(chatId).toBeTruthy();
    if (chatId) {
      await expect(app.db.select().from(messages).where(eq(messages.chatId, chatId))).resolves.toHaveLength(1);
      // The payoff of #1536 is that the tracking delegate is WOKEN, not just
      // that a chat row exists.
      expect(await notifyCount(app, chatId, delegate)).toBe(1);
    }
  });

  it("self-echo carve-out end-to-end: resolveAudience → deliver mints a chat for a self-assigned issue (#1536)", async () => {
    // Closes the loop the hand-built-target tests leave open: drive the REAL
    // `resolveAudience` on a fresh `issues.opened` whose actor == assignee, so
    // the self target is produced by the resolver (not hand-shaped), then let
    // delivery mint the chat. This is the exact interaction #1536 broke —
    // `resolveGithubActorHumanId` resolving the actor to the same human the involve
    // names, which the old blanket prune then dropped.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `human-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });
    const entityKey = "owner/repo#1537";
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "issue",
      entityKey,
      eventType: "issues",
      action: "opened",
      kind: "opened",
      actorLogin: humanName,
      targets: [{ externalUsername: humanName.toLowerCase(), reason: "assigned" }],
    });

    const resolution = await resolveGithubAudience(app.db, event);
    // The actor resolves to the self human, and the sole target is the fresh
    // self-directed involve.
    expect(resolution.actorHumanId).toBe(human);
    expect(resolution.targets).toHaveLength(1);
    expect(resolution.targets[0]).toMatchObject({ humanAgentId: human, kind: "new", involveReason: "assigned" });

    const stats = await deliverGithubEvent(app, event, resolution.targets, {
      actorHumanId: resolution.actorHumanId,
    });
    expect(stats).toEqual({ delivered: 1, newChats: 1, failed: 0 });

    const mapping = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(
        and(
          eq(githubEntityChatMappings.organizationId, admin.organizationId),
          eq(githubEntityChatMappings.entityType, "issue"),
          eq(githubEntityChatMappings.entityKey, entityKey),
        ),
      );
    expect(mapping).toHaveLength(1);
    const chatId = mapping[0]?.chatId;
    expect(chatId).toBeTruthy();
    if (chatId) {
      expect(await notifyCount(app, chatId, delegate)).toBe(1);
    }
  });

  it("self-echo boundary: a self-assign on an already-bound entity stays pruned (#1536)", async () => {
    // The other side of the #1536 carve-out. When the entity ALREADY has a
    // bound chat (`kind: "existing"`), a self-directed involve is a true echo
    // of the actor's own action into a chat they already sit in — nothing new
    // to create — so it must stay pruned even though it carries an
    // `involveReason`. Locks the carve-out to `kind: "new"` only.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `human-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
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
      entityType: "issue",
      entityKey: "owner/repo#207",
      chatId,
      boundVia: "direct",
    });
    const target = {
      humanAgentId: human,
      delegateAgentId: delegate,
      kind: "existing",
      chatId,
      involveReason: "assigned",
      involveLogin: humanName.toLowerCase(),
    } satisfies AudienceTarget;
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "issue",
      entityKey: "owner/repo#207",
      eventType: "issues",
      action: "assigned",
      actorLogin: humanName,
      targets: [{ externalUsername: humanName.toLowerCase(), reason: "assigned" }],
    });

    const stats = await deliverGithubEvent(app, event, [target], { actorHumanId: human });
    expect(stats).toEqual({ delivered: 0, newChats: 0, failed: 0 });
    await expect(app.db.select().from(messages).where(eq(messages.chatId, chatId))).resolves.toHaveLength(0);
    await expect(app.db.select().from(inboxEntries).where(eq(inboxEntries.chatId, chatId))).resolves.toHaveLength(0);
  });

  it("humanA requesting humanB review prunes humanA's follow delivery and wakes humanB's delegate", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegateA = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-a-${randomUUID().slice(0, 6)}`,
    });
    const humanAName = `human-a-${randomUUID().slice(0, 6)}`;
    const humanA = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanAName,
      delegateMention: delegateA,
      type: "human",
    });
    const delegateB = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-b-${randomUUID().slice(0, 6)}`,
    });
    const humanBName = `human-b-${randomUUID().slice(0, 6)}`;
    const humanB = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanBName,
      delegateMention: delegateB,
      type: "human",
    });

    const chatA = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatA, organizationId: admin.organizationId, type: "group" });
    await app.db.insert(chatMembership).values([
      { chatId: chatA, agentId: humanA, role: "owner", accessMode: "speaker", mode: "full", source: "manual" },
      { chatId: chatA, agentId: delegateA, role: "member", accessMode: "speaker", mode: "full", source: "manual" },
    ]);
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: humanA,
      delegateAgentId: delegateA,
      entityType: "pull_request",
      entityKey: "owner/repo#206",
      chatId: chatA,
      boundVia: "agent_declared",
    });

    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#206",
      actorLogin: humanAName,
      targets: [{ externalUsername: humanBName, reason: "review_requested" }],
      kind: "review_requested",
      action: "review_requested",
    });
    const resolution = await resolveGithubAudience(app.db, event);
    expect(resolution.actorHumanId).toBe(humanA);

    const stats = await deliverGithubEvent(app, event, resolution.targets, {
      actorHumanId: resolution.actorHumanId,
    });
    expect(stats).toEqual({ delivered: 1, newChats: 1, failed: 0 });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, chatA))).toHaveLength(0);
    expect(await notifyCount(app, chatA, delegateA)).toBe(0);

    const [mappingB] = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(
        and(
          eq(githubEntityChatMappings.entityKey, "owner/repo#206"),
          eq(githubEntityChatMappings.humanAgentId, humanB),
        ),
      )
      .limit(1);
    expect(mappingB?.delegateAgentId).toBe(delegateB);
    expect(mappingB?.chatId).toBeTruthy();
    const chatB = mappingB?.chatId ?? "";
    expect(await notifyCount(app, chatB, delegateB)).toBe(1);
    const [messageB] = await app.db.select().from(messages).where(eq(messages.chatId, chatB)).limit(1);
    expect(messageB?.senderId).toBe(humanB);
  });

  it("reviewer comment prunes the reviewer's own follow chat but not the PR author's chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegateA = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-a-${randomUUID().slice(0, 6)}`,
    });
    const humanA = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-a-${randomUUID().slice(0, 6)}`,
      delegateMention: delegateA,
      type: "human",
    });
    const delegateB = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-b-${randomUUID().slice(0, 6)}`,
    });
    const humanBName = `human-b-${randomUUID().slice(0, 6)}`;
    const humanB = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanBName,
      delegateMention: delegateB,
      type: "human",
    });
    const chatA = `chat_${randomUUID()}`;
    const chatB = `chat_${randomUUID()}`;
    await app.db.insert(chats).values([
      { id: chatA, organizationId: admin.organizationId, type: "group" },
      { id: chatB, organizationId: admin.organizationId, type: "group" },
    ]);
    await app.db.insert(chatMembership).values([
      { chatId: chatA, agentId: humanA, role: "owner", accessMode: "speaker", mode: "full", source: "manual" },
      { chatId: chatA, agentId: delegateA, role: "member", accessMode: "speaker", mode: "full", source: "manual" },
      { chatId: chatB, agentId: humanB, role: "owner", accessMode: "speaker", mode: "full", source: "manual" },
      { chatId: chatB, agentId: delegateB, role: "member", accessMode: "speaker", mode: "full", source: "manual" },
    ]);
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: humanA,
        delegateAgentId: delegateA,
        entityType: "pull_request",
        entityKey: "owner/repo#207",
        chatId: chatA,
        boundVia: "agent_declared",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: humanB,
        delegateAgentId: delegateB,
        entityType: "pull_request",
        entityKey: "owner/repo#207",
        chatId: chatB,
        boundVia: "direct",
      },
    ]);

    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#207",
      actorLogin: humanBName,
      eventType: "issue_comment",
      action: "created",
      kind: "commented",
    });
    const resolution = await resolveGithubAudience(app.db, event);
    expect(resolution.actorHumanId).toBe(humanB);
    const stats = await deliverGithubEvent(app, event, resolution.targets, {
      actorHumanId: resolution.actorHumanId,
    });

    expect(stats).toEqual({ delivered: 1, newChats: 0, failed: 0 });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, chatA))).toHaveLength(1);
    expect(await app.db.select().from(messages).where(eq(messages.chatId, chatB))).toHaveLength(0);
    expect(await notifyCount(app, chatA, delegateA)).toBe(1);
    expect(await notifyCount(app, chatB, delegateB)).toBe(0);
  });

  it("mixed chat echo pruning removes only the actor's entry", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegateA = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-a-${randomUUID().slice(0, 6)}`,
    });
    const humanAName = `human-a-${randomUUID().slice(0, 6)}`;
    const humanA = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanAName,
      delegateMention: delegateA,
      type: "human",
    });
    const delegateB = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-b-${randomUUID().slice(0, 6)}`,
    });
    const humanBName = `human-b-${randomUUID().slice(0, 6)}`;
    const humanB = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanBName,
      delegateMention: delegateB,
      type: "human",
    });
    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
    await app.db.insert(chatMembership).values(
      [humanA, delegateA, humanB, delegateB].map((agentId, index) => ({
        chatId,
        agentId,
        role: index === 0 ? "owner" : "member",
        accessMode: "speaker" as const,
        mode: "full" as const,
        source: "manual" as const,
      })),
    );
    await app.db.insert(githubEntityChatMappings).values([
      {
        organizationId: admin.organizationId,
        humanAgentId: humanA,
        delegateAgentId: delegateA,
        entityType: "pull_request",
        entityKey: "owner/repo#208",
        chatId,
        boundVia: "agent_declared",
      },
      {
        organizationId: admin.organizationId,
        humanAgentId: humanB,
        delegateAgentId: delegateB,
        entityType: "pull_request",
        entityKey: "owner/repo#208",
        chatId,
        boundVia: "direct",
      },
    ]);

    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#208",
      actorLogin: humanAName,
      targets: [{ externalUsername: humanBName, reason: "mentioned" }],
      eventType: "issue_comment",
      action: "created",
      kind: "commented",
    });
    const resolution = await resolveGithubAudience(app.db, event);
    expect(resolution.actorHumanId).toBe(humanA);

    const stats = await deliverGithubEvent(app, event, resolution.targets, {
      actorHumanId: resolution.actorHumanId,
    });
    expect(stats).toEqual({ delivered: 1, newChats: 0, failed: 0 });
    const [message] = await app.db.select().from(messages).where(eq(messages.chatId, chatId)).limit(1);
    expect(message?.senderId).toBe(humanB);
    const metadata = message?.metadata as { mentions?: string[]; reason?: string };
    expect(metadata.mentions).toEqual([delegateB]);
    expect(metadata.reason).toBe("mentioned");
    expect(await notifyCount(app, chatId, delegateA)).toBe(0);
    expect(await notifyCount(app, chatId, delegateB)).toBe(1);
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
      type: "human",
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
    };
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#200",
    });
    await deliverGithubEvent(app, event, [target]);

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
      type: "human",
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
    };
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#200",
      eventType: "pull_request_review",
      action: "submitted",
      title: "Renamed title",
    });
    await deliverGithubEvent(app, event, [target]);

    const [row] = await app.db.select({ topic: chats.topic }).from(chats).where(eq(chats.id, chatId)).limit(1);
    expect(row?.topic).toBe("PR repo#200: Renamed title");

    // The same event also backfills the mapping's persisted `title` (the row
    // was inserted before titles were persisted), so the right sidebar gets a
    // label without a per-row GitHub fetch.
    const [mapping] = await app.db
      .select({ title: githubEntityChatMappings.title })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#200"))
      .limit(1);
    expect(mapping?.title).toBe("Renamed title");
  });

  it("refreshes entity projection even when self-echo pruning drops the card", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `human-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });

    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({
      id: chatId,
      organizationId: admin.organizationId,
      type: "direct",
      topic: "PR repo#209: Old title",
    });
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: human,
      delegateAgentId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#209",
      chatId,
      boundVia: "direct",
      title: "Old title",
    });

    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#209",
      actorLogin: humanName,
      eventType: "pull_request",
      action: "edited",
      kind: "edited",
      title: "New title",
    });
    const resolution = await resolveGithubAudience(app.db, event);
    expect(resolution.actorHumanId).toBe(human);

    const stats = await deliverGithubEvent(app, event, resolution.targets, {
      actorHumanId: resolution.actorHumanId,
    });
    expect(stats).toEqual({ delivered: 0, newChats: 0, failed: 0 });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, chatId))).toHaveLength(0);
    expect(await app.db.select().from(inboxEntries).where(eq(inboxEntries.chatId, chatId))).toHaveLength(0);

    const [chat] = await app.db.select({ topic: chats.topic }).from(chats).where(eq(chats.id, chatId)).limit(1);
    expect(chat?.topic).toBe("PR repo#209: New title");
    const [mapping] = await app.db
      .select({ title: githubEntityChatMappings.title })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#209"))
      .limit(1);
    expect(mapping?.title).toBe("New title");
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
      type: "human",
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
    };
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#99",
      title: "Fix the login bug",
    });
    await deliverGithubEvent(app, event, [target]);

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
      type: "human",
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
    };
    const event = makeEvent({
      orgId: admin.organizationId,
      entityType: "pull_request",
      entityKey: "owner/repo#999",
    });
    await deliverGithubEvent(app, event, [target]);

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
      type: "human",
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
      targets: [{ externalUsername: humanName, reason: "review_requested" }],
    });
    const stats = await deliverGithubEvent(app, event, [target]);

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
      type: "human",
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

    const stats = await deliverGithubEvent(app, event, [broken, ok]);
    expect(stats.delivered).toBe(1);
    // M1 (#507): the broken target's exception must be counted, not
    // silently swallowed by the per-target catch — operators dashboard
    // off this counter to spot regressions in single-target reliability.
    expect(stats.failed).toBe(1);
    const sent = await app.db.select().from(messages).where(eq(messages.chatId, goodChatId));
    expect(sent).toHaveLength(1);
  });

  it("reviewer-reuse + per-chat dedup: an involved member routes into the existing chat (one card, both delegates woken, no new chat/mapping)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const mk = (p: string) =>
      seedAgent(app, {
        orgId: admin.organizationId,
        memberId: admin.memberId,
        name: `${p}-${randomUUID().slice(0, 6)}`,
      });
    const delegateA = await mk("dlgA");
    const humanA = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `humanA-${randomUUID().slice(0, 6)}`,
      delegateMention: delegateA,
      type: "human",
    });
    const delegateR = await mk("dlgR");
    const humanR = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `humanR-${randomUUID().slice(0, 6)}`,
      delegateMention: delegateR,
      type: "human",
    });

    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
    // All four are speakers of the one chat (reviewer + its delegate are already members).
    await app.db.insert(chatMembership).values(
      [humanA, delegateA, humanR, delegateR].map((agentId, i) => ({
        chatId,
        agentId,
        role: i === 0 ? "owner" : "member",
        accessMode: "speaker" as const,
        mode: "full" as const,
        source: "manual" as const,
      })),
    );
    // The entity is bound to this chat under (humanA, delegateA) only.
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: humanA,
      delegateAgentId: delegateA,
      entityType: "pull_request",
      entityKey: "owner/repo#210",
      chatId,
      boundVia: "direct",
    });

    const event = makeEvent({ orgId: admin.organizationId, entityType: "pull_request", entityKey: "owner/repo#210" });
    const subscribed: AudienceTarget = {
      humanAgentId: humanA,
      delegateAgentId: delegateA,
      kind: "existing",
      chatId,
      involveReason: null,
      involveLogin: null,
    };
    const involved: AudienceTarget = {
      humanAgentId: humanR,
      delegateAgentId: delegateR,
      kind: "new",
      chatId: null,
      involveReason: "review_requested",
      involveLogin: "humanr",
    };

    const stats = await deliverGithubEvent(app, event, [subscribed, involved]);

    // No new chat minted; exactly one card delivered to the single chat.
    expect(stats.newChats).toBe(0);
    expect(stats.delivered).toBe(1);
    const sent = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(sent).toHaveLength(1);

    // Union wake-set: BOTH delegates are woken via native mentions.
    const wokenCount = async (agentUuid: string) => {
      const [a] = await app.db
        .select({ inboxId: agents.inboxId })
        .from(agents)
        .where(eq(agents.uuid, agentUuid))
        .limit(1);
      const rows = await app.db
        .select({ id: inboxEntries.messageId })
        .from(inboxEntries)
        .where(
          and(
            eq(inboxEntries.inboxId, a?.inboxId ?? ""),
            eq(inboxEntries.chatId, chatId),
            eq(inboxEntries.notify, true),
          ),
        );
      return rows.length;
    };
    expect(await wokenCount(delegateA)).toBe(1);
    expect(await wokenCount(delegateR)).toBe(1);

    // No reviewer mapping row was written — reuse routes by membership, not subscription.
    const mappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "owner/repo#210"));
    expect(mappings).toHaveLength(1);
  });

  it("a `mentioned` involve does NOT reuse the entity chat — it mints a fresh chat (S5, reuse is review_requested-only)", async () => {
    // S9 reuse is scoped to review_requested. An @mention of a human who is
    // already a speaker of the entity's bound chat must still pierce into a
    // FRESH chat (S5), never get routed back into the existing one.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegateA = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlgA-${randomUUID().slice(0, 6)}`,
    });
    const humanA = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `humanA-${randomUUID().slice(0, 6)}`,
      delegateMention: delegateA,
      type: "human",
    });
    const delegateM = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlgM-${randomUUID().slice(0, 6)}`,
    });
    const humanM = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `humanM-${randomUUID().slice(0, 6)}`,
      delegateMention: delegateM,
      type: "human",
    });

    const chatId = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
    // The mentioned human + its delegate are BOTH already speakers of the bound chat.
    await app.db.insert(chatMembership).values(
      [humanA, delegateA, humanM, delegateM].map((agentId, i) => ({
        chatId,
        agentId,
        role: i === 0 ? "owner" : "member",
        accessMode: "speaker" as const,
        mode: "full" as const,
        source: "manual" as const,
      })),
    );
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: admin.organizationId,
      humanAgentId: humanA,
      delegateAgentId: delegateA,
      entityType: "pull_request",
      entityKey: "owner/repo#211",
      chatId,
      boundVia: "direct",
    });

    const event = makeEvent({ orgId: admin.organizationId, entityType: "pull_request", entityKey: "owner/repo#211" });
    const involvedMention: AudienceTarget = {
      humanAgentId: humanM,
      delegateAgentId: delegateM,
      kind: "new",
      chatId: null,
      involveReason: "mentioned",
      involveLogin: "humanm",
    };

    const stats = await deliverGithubEvent(app, event, [involvedMention]);

    // A fresh chat was minted for the mention (NOT reused into the bound chat).
    expect(stats.newChats).toBe(1);
    const mintedMappings = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(
        and(
          eq(githubEntityChatMappings.entityKey, "owner/repo#211"),
          eq(githubEntityChatMappings.humanAgentId, humanM),
        ),
      );
    expect(mintedMappings).toHaveLength(1);
    expect(mintedMappings[0]?.chatId).not.toBe(chatId);
  });

  // Regression: a GitHub-bound chat that has been expanded to >=3 speakers
  // (e.g. a teammate invited in) must still wake the delegate agent that
  // owns the entity. github-delivery wakes the delegate by adding it to the
  // card's native `metadata.mentions`; before that, a card-format message in a
  // multi-speaker chat produced no mentionSet and the fan-out collapsed to
  // `notify=false` for everyone, so the agent never woke.
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
      type: "human",
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
    const stats = await deliverGithubEvent(app, event, [target]);
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

  it("prunes every self-owned follow delivery even when the actor has multiple mapped chats", async () => {
    // Stage 2 must still keep distinct (human, chat) mappings so routing facts
    // are not lost, but Stage 3 removes entries owned by actorHuman before
    // sending. With no other human entry left, neither chat gets a card.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const humanName = `rep-human-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      type: "human",
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
      action: "synchronize",
    });

    // Stage 2: both chats survive. M2 keeps the (human, chat) pairs distinct.
    const resolution = await resolveGithubAudience(app.db, event);
    const audience = resolution.targets;
    expect(audience).toHaveLength(2);
    expect(new Set(audience.map((a) => a.chatId))).toEqual(new Set([chatA, chatB]));
    expect(resolution.actorHumanId).toBe(human);

    const stats = await deliverGithubEvent(app, event, audience, { actorHumanId: resolution.actorHumanId });
    expect(stats).toEqual({ delivered: 0, newChats: 0, failed: 0 });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, chatA))).toHaveLength(0);
    expect(await app.db.select().from(messages).where(eq(messages.chatId, chatB))).toHaveLength(0);
    expect(await app.db.select().from(inboxEntries).where(eq(inboxEntries.notify, true))).toHaveLength(0);
  });
});
