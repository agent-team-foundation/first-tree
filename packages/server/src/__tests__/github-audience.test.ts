import { randomUUID } from "node:crypto";
import type { NormalizedScmEvent } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import {
  resolveGithubAudience as resolveAudienceResolution,
  resolveGithubActorHumanId,
} from "../services/github-audience.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

async function resolveAudience(
  db: Parameters<typeof resolveAudienceResolution>[0],
  event: Parameters<typeof resolveAudienceResolution>[1],
) {
  return (await resolveAudienceResolution(db, event)).targets;
}

async function seedAgent(
  app: App,
  opts: {
    orgId: string;
    memberId: string;
    name: string;
    type?: "agent" | "human";
    status?: "active" | "suspended";
    delegateMention?: string | null;
  },
): Promise<string> {
  const uuid = randomUUID();
  await app.db.insert(agents).values({
    uuid,
    name: opts.name,
    organizationId: opts.orgId,
    type: opts.type ?? "agent",
    displayName: opts.name,
    inboxId: `inbox_${uuid}`,
    managerId: opts.memberId,
    delegateMention: opts.delegateMention ?? null,
    status: opts.status ?? "active",
  });
  return uuid;
}

async function seedChat(app: App, orgId: string, _humanId: string): Promise<string> {
  const id = `chat_${randomUUID()}`;
  await app.db.insert(chats).values({
    id,
    organizationId: orgId,
    type: "direct",
    metadata: {},
  });
  return id;
}

async function seedMapping(
  app: App,
  opts: {
    orgId: string;
    humanId: string;
    delegateId: string;
    entityType: "issue" | "pull_request" | "discussion" | "commit";
    entityKey: string;
    chatId: string;
    boundVia?: "direct" | "fixes_link" | "agent_declared" | "human_declared" | "human_fallback";
  },
): Promise<void> {
  await app.db.insert(githubEntityChatMappings).values({
    organizationId: opts.orgId,
    humanAgentId: opts.humanId,
    delegateAgentId: opts.delegateId,
    entityType: opts.entityType,
    entityKey: opts.entityKey,
    chatId: opts.chatId,
    boundVia: opts.boundVia ?? "direct",
  });
}

// Default `(eventType, action)` per normalized `kind`, so a test's wire
// fields stay coherent with the scenario it describes. The #766 subscribed-
// suppression keys off `(eventType === "pull_request", action ===
// "opened")`, so a test that means "synchronize" must NOT leak a stray
// `action: "opened"`. Callers can still override either field explicitly.
const KIND_TO_ACTION: Record<NormalizedScmEvent["kind"], string> = {
  opened: "opened",
  edited: "edited",
  closed: "closed",
  merged: "closed",
  reopened: "reopened",
  commented: "created",
  reviewed: "submitted",
  review_comment: "created",
  review_requested: "review_requested",
  synchronized: "synchronize",
  assigned: "assigned",
  commit_commented: "created",
  other: "other",
};

const ENTITY_TO_EVENT_TYPE: Record<"issue" | "pull_request" | "discussion" | "commit", string> = {
  issue: "issues",
  pull_request: "pull_request",
  discussion: "discussion",
  commit: "commit_comment",
};

function makeEvent(opts: {
  orgId: string;
  installationId?: number;
  entityType: "issue" | "pull_request" | "discussion" | "commit";
  entityKey: string;
  actorLogin: string;
  actorIsBot?: boolean;
  targets?: Array<{ externalUsername: string; reason: "mentioned" | "review_requested" | "assigned" }>;
  kind?: NormalizedScmEvent["kind"];
  eventType?: string;
  action?: string;
}): NormalizedScmEvent {
  const kind = opts.kind ?? "opened";
  return {
    provider: "github",
    source: {
      organizationId: opts.orgId,
      externalId: `installation:${opts.installationId ?? 1}`,
    },
    stableDeliveryId: "delivery-1",
    ingressAuthority: "verified_signature",
    eventType: opts.eventType ?? ENTITY_TO_EVENT_TYPE[opts.entityType],
    action: opts.action ?? KIND_TO_ACTION[kind],
    entity: {
      type: opts.entityType,
      projectKey: "owner/repo",
      key: opts.entityKey,
      title: "X",
      url: "https://github.com/owner/repo",
    },
    actor: { externalUsername: opts.actorLogin, isBot: opts.actorIsBot ?? false },
    kind,
    targets: opts.targets ?? [],
    surface: { title: "X", body: "", url: "" },
    relatedRefs: [],
  };
}

describe("resolveGithubActorHumanId", () => {
  const getApp = useTestApp();

  it("returns the human agent id when the sender login matches an org human (case-insensitive)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const humanId = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `alice-${randomUUID().slice(0, 6)}`,
      type: "human",
    });
    const [row] = await app.db.select({ name: agents.name }).from(agents).where(eq(agents.uuid, humanId)).limit(1);
    if (!row?.name) throw new Error("seeded agent has no name");
    const id = await resolveGithubActorHumanId(app.db, admin.organizationId, {
      externalUsername: row.name.toUpperCase(),
    });
    expect(id).toBe(humanId);
  });

  it("returns null when the sender login matches a non-human agent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agentId = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `agent-${randomUUID().slice(0, 6)}`,
    });
    const [row] = await app.db.select({ name: agents.name }).from(agents).where(eq(agents.uuid, agentId)).limit(1);
    if (!row?.name) throw new Error("seeded agent has no name");
    const id = await resolveGithubActorHumanId(app.db, admin.organizationId, { externalUsername: row.name });
    expect(id).toBeNull();
  });

  it("returns null for unknown senders and bots", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await expect(
      resolveGithubActorHumanId(app.db, admin.organizationId, { externalUsername: "stranger" }),
    ).resolves.toBeNull();
    await expect(
      resolveGithubActorHumanId(app.db, admin.organizationId, { externalUsername: "first-tree[bot]" }),
    ).resolves.toBeNull();
  });
});

describe("resolveAudience", () => {
  const getApp = useTestApp();

  it("returns subscribed mappings (existing) when no fresh involves", async () => {
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
    const chatId = await seedChat(app, admin.organizationId, humanA);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: humanA,
      delegateId: delegateA,
      entityType: "pull_request",
      entityKey: "owner/repo#100",
      chatId,
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#100",
        actorLogin: "outsider",
        kind: "synchronized",
      }),
    );

    expect(audience).toEqual([
      {
        humanAgentId: humanA,
        delegateAgentId: delegateA,
        kind: "existing",
        chatId,
        involveReason: null,
        involveLogin: null,
        provenance: "identity_target",
      },
    ]);
  });

  it("returns legacy discussion subscriptions when the event key is canonical numeric", async () => {
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
    const chatId = await seedChat(app, admin.organizationId, humanA);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: humanA,
      delegateId: delegateA,
      entityType: "discussion",
      entityKey: "owner/repo#discussion-7",
      chatId,
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "discussion",
        entityKey: "owner/repo#7",
        actorLogin: "outsider",
        kind: "commented",
        eventType: "discussion_comment",
      }),
    );

    expect(audience).toEqual([
      {
        humanAgentId: humanA,
        delegateAgentId: delegateA,
        kind: "existing",
        chatId,
        involveReason: null,
        involveLogin: null,
        provenance: "identity_target",
      },
    ]);
  });

  it("adds involved-new rows for fresh @mentions, carrying the InvolveReason", async () => {
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

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#101",
        actorLogin: "outsider",
        targets: [{ externalUsername: humanName, reason: "review_requested" }],
        kind: "review_requested",
      }),
    );

    expect(audience).toEqual([
      {
        humanAgentId: human,
        delegateAgentId: delegate,
        kind: "new",
        chatId: null,
        involveReason: "review_requested",
        involveLogin: humanName.toLowerCase(),
      },
    ]);
  });

  it("target human reuses an existing mapping instead of creating a new delegate route", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `carol-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = await seedChat(app, admin.organizationId, human);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: human,
      delegateId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#102",
      chatId,
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#102",
        actorLogin: "outsider",
        targets: [{ externalUsername: humanName, reason: "mentioned" }],
        kind: "commented",
      }),
    );

    expect(audience).toHaveLength(1);
    expect(audience[0]?.kind).toBe("existing");
    expect(audience[0]?.chatId).toBe(chatId);
    expect(audience[0]?.delegateAgentId).toBe(delegate);
    expect(audience[0]?.involveReason).toBe("mentioned");
    expect(audience[0]?.involveLogin).toBe(humanName.toLowerCase());
  });

  it("collapses subscribed rows by human (sibling mappings on same chat → one audience target)", async () => {
    // Once `resolveTargetChat` step (a.5) lands sibling mapping rows
    // (same chat, different delegate under the same human), naive subscribed
    // expansion would post the same card to the chat N times. Subscribed
    // dedup collapses by humanAgentId; sibling rows always share chatId by
    // construction, so we keep the earliest bound_at row as the
    // representative.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegateOriginal = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-original-${randomUUID().slice(0, 6)}`,
    });
    const delegateSibling = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-sibling-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `eve-${randomUUID().slice(0, 6)}`,
    });
    const chatId = await seedChat(app, admin.organizationId, human);

    // Original row first (earlier bound_at), then sibling — simulates the
    // (a.5) write order. We do not control bound_at directly; the default
    // `now()` clock + serial insert order suffices because the assertions
    // only require the representative to be one of the two rows sharing
    // chatId, and both point at the same chat.
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: human,
      delegateId: delegateOriginal,
      entityType: "issue",
      entityKey: "owner/repo#301",
      chatId,
    });
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: human,
      delegateId: delegateSibling,
      entityType: "issue",
      entityKey: "owner/repo#301",
      chatId,
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "issue",
        entityKey: "owner/repo#301",
        actorLogin: "outsider",
        kind: "commented",
      }),
    );

    expect(audience).toHaveLength(1);
    expect(audience[0]?.kind).toBe("existing");
    expect(audience[0]?.humanAgentId).toBe(human);
    expect(audience[0]?.chatId).toBe(chatId);
  });

  it("M2: does NOT collapse subscribed rows across different chats for the same human", async () => {
    // Regression for the multi-human-not-pushed bug: the same human can be
    // bound to one entity from two different chats (e.g. a webhook
    // `human_fallback` row in chat A under delegateA plus an explicit follow
    // row in chat B under delegateB). Deduping by `humanAgentId` alone kept
    // only the earliest chat and silently dropped the *other* followed chat
    // from the audience. Dedup is keyed by `(human, chat)`, so BOTH chats
    // receive the event.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegateA = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-a-${randomUUID().slice(0, 6)}`,
    });
    const delegateB = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-b-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `frank-${randomUUID().slice(0, 6)}`,
    });
    const chatA = await seedChat(app, admin.organizationId, human);
    const chatB = await seedChat(app, admin.organizationId, human);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: human,
      delegateId: delegateA,
      entityType: "issue",
      entityKey: "owner/repo#303",
      chatId: chatA,
    });
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: human,
      delegateId: delegateB,
      entityType: "issue",
      entityKey: "owner/repo#303",
      chatId: chatB,
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "issue",
        entityKey: "owner/repo#303",
        actorLogin: "outsider",
        kind: "commented",
      }),
    );

    expect(audience).toHaveLength(2);
    expect(audience.every((a) => a.kind === "existing")).toBe(true);
    expect(new Set(audience.map((a) => a.chatId))).toEqual(new Set([chatA, chatB]));
  });

  it("dedups involves by human even when the existing mapping uses a different delegate", async () => {
    // Regression for the assignee-creates-new-chat bug. The chat-binding was
    // written under (human, delegateA) when the agent first created the
    // entity. A later assign webhook arrives with involves=[human]; the human
    // is configured with delegateMention=delegateB. Audience must dedup by
    // human alone so the involves path does NOT add a sibling `kind: "new"`
    // row — the entity is already routed to the existing chat.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegateA = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-a-${randomUUID().slice(0, 6)}`,
    });
    const delegateB = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-b-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `dave-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegateB,
      type: "human",
    });
    const chatId = await seedChat(app, admin.organizationId, human);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: human,
      delegateId: delegateA,
      entityType: "issue",
      entityKey: "owner/repo#202",
      chatId,
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "issue",
        entityKey: "owner/repo#202",
        actorLogin: "outsider",
        targets: [{ externalUsername: humanName, reason: "assigned" }],
        kind: "assigned",
      }),
    );

    expect(audience).toHaveLength(1);
    expect(audience[0]?.kind).toBe("existing");
    expect(audience[0]?.delegateAgentId).toBe(delegateA);
    expect(audience[0]?.chatId).toBe(chatId);
    expect(audience[0]?.involveReason).toBe("assigned");
    expect(audience[0]?.involveLogin).toBe(humanName.toLowerCase());
  });

  it("keeps subscribed targets when actor is an unresolved app bot", async () => {
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
    const chatId = await seedChat(app, admin.organizationId, human);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: human,
      delegateId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#103",
      chatId,
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#103",
        actorLogin: "first-tree[bot]",
        actorIsBot: true,
        kind: "synchronized",
      }),
    );

    expect(audience).toHaveLength(1);
    expect(audience[0]?.kind).toBe("existing");
    expect(audience[0]?.chatId).toBe(chatId);
  });

  it("keeps target deliveries when actor is an unresolved app bot", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `human-${randomUUID().slice(0, 6)}`;
    await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#104",
        actorLogin: "first-tree[bot]",
        actorIsBot: true,
        targets: [{ externalUsername: humanName, reason: "mentioned" }],
        kind: "opened",
      }),
    );

    expect(audience).toHaveLength(1);
    expect(audience[0]).toMatchObject({
      kind: "new",
      involveReason: "mentioned",
      involveLogin: humanName.toLowerCase(),
    });
  });

  it("resolves actorHumanId separately while keeping every audience target", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const otherDelegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-other-${randomUUID().slice(0, 6)}`,
    });
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const otherHuman = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-other-${randomUUID().slice(0, 6)}`,
      delegateMention: otherDelegate,
      type: "human",
    });
    const chatHuman = await seedChat(app, admin.organizationId, human);
    const chatOther = await seedChat(app, admin.organizationId, otherHuman);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: human,
      delegateId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#104",
      chatId: chatHuman,
    });
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: otherHuman,
      delegateId: otherDelegate,
      entityType: "pull_request",
      entityKey: "owner/repo#104",
      chatId: chatOther,
    });

    // Actor identity is carried as a separate human id. Audience construction
    // still returns every route; delivery prunes the actor's own entry later.
    const [humanRow] = await app.db.select({ name: agents.name }).from(agents).where(eq(agents.uuid, human)).limit(1);
    const resolution = await resolveAudienceResolution(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#104",
        actorLogin: humanRow?.name ?? "",
        kind: "synchronized",
      }),
    );
    const audience = resolution.targets;
    expect(audience).toHaveLength(2);
    expect(new Set(audience.map((a) => a.humanAgentId))).toEqual(new Set([human, otherHuman]));
    expect(resolution.actorHumanId).toBe(human);
  });

  it("keeps a self target as an audience candidate for delivery pruning", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `self-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "issue",
        entityKey: "owner/repo#108",
        actorLogin: humanName,
        targets: [{ externalUsername: humanName, reason: "mentioned" }],
        kind: "commented",
      }),
    );

    expect(audience).toHaveLength(1);
    expect(audience[0]).toMatchObject({
      humanAgentId: human,
      delegateAgentId: delegate,
      kind: "new",
      involveReason: "mentioned",
      involveLogin: humanName.toLowerCase(),
    });
  });

  it("self target on an already-subscribed entity reuses the existing row", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `self-sub-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = await seedChat(app, admin.organizationId, human);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: human,
      delegateId: delegate,
      entityType: "issue",
      entityKey: "owner/repo#110",
      chatId,
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "issue",
        entityKey: "owner/repo#110",
        actorLogin: humanName,
        targets: [{ externalUsername: humanName, reason: "mentioned" }],
        kind: "commented",
      }),
    );

    expect(audience).toHaveLength(1);
    expect(audience[0]).toMatchObject({
      humanAgentId: human,
      delegateAgentId: delegate,
      kind: "existing",
      chatId,
      involveReason: "mentioned",
      involveLogin: humanName.toLowerCase(),
    });
  });

  it("creation self target remains a candidate and is identified by actorHumanId", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const creatorName = `creator-${randomUUID().slice(0, 6)}`;
    const creator = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: creatorName,
      delegateMention: delegate,
      type: "human",
    });

    const resolution = await resolveAudienceResolution(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#600",
        actorLogin: creatorName,
        targets: [{ externalUsername: creatorName, reason: "assigned" }],
        kind: "opened",
      }),
    );

    expect(resolution.actorHumanId).toBe(creator);
    expect(resolution.targets).toHaveLength(1);
    expect(resolution.targets[0]).toMatchObject({
      humanAgentId: creator,
      kind: "new",
      involveReason: "assigned",
    });
  });

  it("creation with self and another target keeps both candidates for delivery pruning", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const creatorDelegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-creator-${randomUUID().slice(0, 6)}`,
    });
    const creatorName = `creator-${randomUUID().slice(0, 6)}`;
    const creator = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: creatorName,
      delegateMention: creatorDelegate,
      type: "human",
    });
    const otherDelegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-other-${randomUUID().slice(0, 6)}`,
    });
    const otherName = `other-${randomUUID().slice(0, 6)}`;
    const other = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: otherName,
      delegateMention: otherDelegate,
      type: "human",
    });

    const resolution = await resolveAudienceResolution(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#601",
        actorLogin: creatorName,
        targets: [
          { externalUsername: creatorName, reason: "assigned" },
          { externalUsername: otherName, reason: "mentioned" },
        ],
        kind: "opened",
      }),
    );
    const audience = resolution.targets;

    expect(resolution.actorHumanId).toBe(creator);
    expect(audience).toHaveLength(2);
    expect(new Set(audience.map((target) => target.humanAgentId))).toEqual(new Set([creator, other]));
  });

  it("creation self target reuses the creator's declared follow chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const creatorName = `creator-${randomUUID().slice(0, 6)}`;
    const creator = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: creatorName,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = await seedChat(app, admin.organizationId, creator);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: creator,
      delegateId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#602",
      chatId,
      boundVia: "agent_declared",
    });

    const resolution = await resolveAudienceResolution(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#602",
        actorLogin: creatorName,
        targets: [{ externalUsername: creatorName, reason: "assigned" }],
        kind: "opened",
      }),
    );
    const audience = resolution.targets;

    expect(resolution.actorHumanId).toBe(creator);
    expect(audience).toHaveLength(1);
    expect(audience[0]?.kind).toBe("existing");
    expect(audience[0]?.chatId).toBe(chatId);
    expect(audience[0]?.involveReason).toBe("assigned");
  });

  it("skips an involve whose delegate target is inactive (suspended/deleted)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const inactiveDelegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `inactive-dlg-${randomUUID().slice(0, 6)}`,
      status: "suspended",
    });
    const humanInactiveName = `inactive-human-${randomUUID().slice(0, 6)}`;
    await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanInactiveName,
      delegateMention: inactiveDelegate,
      type: "human",
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#105",
        actorLogin: "outsider",
        targets: [{ externalUsername: humanInactiveName, reason: "mentioned" }],
        kind: "opened",
      }),
    );

    expect(audience).toEqual([]);
  });

  it("does NOT involve a human agent without delegate_mention", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const humanName = `no-dlg-${randomUUID().slice(0, 6)}`;
    await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      type: "human",
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#106",
        actorLogin: "outsider",
        targets: [{ externalUsername: humanName, reason: "mentioned" }],
        kind: "opened",
      }),
    );

    expect(audience).toEqual([]);
  });

  it("two mentions sharing the same reason yield two targets each with their OWN involveLogin", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegateBob = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-bob-${randomUUID().slice(0, 6)}`,
    });
    const delegateCarol = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-carol-${randomUUID().slice(0, 6)}`,
    });
    const bobName = `bob-${randomUUID().slice(0, 6)}`;
    const carolName = `carol-${randomUUID().slice(0, 6)}`;
    const bob = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: bobName,
      delegateMention: delegateBob,
      type: "human",
    });
    const carol = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: carolName,
      delegateMention: delegateCarol,
      type: "human",
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#107",
        actorLogin: "outsider",
        targets: [
          { externalUsername: bobName, reason: "mentioned" },
          { externalUsername: carolName, reason: "mentioned" },
        ],
        kind: "opened",
      }),
    );

    expect(audience).toHaveLength(2);
    const bobTarget = audience.find((a) => a.humanAgentId === bob);
    const carolTarget = audience.find((a) => a.humanAgentId === carol);
    expect(bobTarget?.involveLogin).toBe(bobName.toLowerCase());
    expect(bobTarget?.involveReason).toBe("mentioned");
    expect(carolTarget?.involveLogin).toBe(carolName.toLowerCase());
    expect(carolTarget?.involveReason).toBe("mentioned");
  });

  it("#766: suppresses a subscribed pull_request.opened card minted by review routing", async () => {
    // PR creation fires `opened` + `review_requested` near-simultaneously.
    // When `review_requested` lands first it mints a `direct` mapping for the
    // reviewer; the racing `opened` then sees that mapping and would fan out a
    // redundant "opened this" next to the actionable "requested your review".
    // The reviewer is not in the `opened` involves (normalize excludes
    // reviewers), so the subscribed `opened` must be dropped.
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
      name: `reviewer-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = await seedChat(app, admin.organizationId, human);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: human,
      delegateId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#500",
      chatId,
      boundVia: "direct",
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#500",
        actorLogin: "outsider",
        kind: "opened",
      }),
    );

    expect(audience).toEqual([]);
  });

  it("#766: keeps a subscribed pull_request.opened card when the mapping is declared (PR confirmation)", async () => {
    // The agent opened this PR inside the chat and followed it in the same
    // breath (`github follow` wrote an `agent_declared` mapping before the
    // webhook landed). The `opened` webhook arrives as `<app>[bot]`; the
    // "opened this" card is the deliberate confirmation that the PR was
    // created and must survive.
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
      name: `author-${randomUUID().slice(0, 6)}`,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = await seedChat(app, admin.organizationId, human);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: human,
      delegateId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#501",
      chatId,
      boundVia: "agent_declared",
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#501",
        actorLogin: "first-tree[bot]",
        actorIsBot: true,
        kind: "opened",
      }),
    );

    expect(audience).toHaveLength(1);
    expect(audience[0]?.kind).toBe("existing");
    expect(audience[0]?.chatId).toBe(chatId);
  });

  it("#766: keeps a subscribed pull_request.opened card when the target is explicitly assigned in the opened payload", async () => {
    // A subscribed reviewer who is *also* an assignee (or @-mentioned) in the
    // opened body is named explicitly by GitHub — a directed signal, not
    // review-routing spillover — so the subscribed card is preserved.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `dlg-${randomUUID().slice(0, 6)}`,
    });
    const humanName = `assignee-${randomUUID().slice(0, 6)}`;
    const human = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: humanName,
      delegateMention: delegate,
      type: "human",
    });
    const chatId = await seedChat(app, admin.organizationId, human);
    await seedMapping(app, {
      orgId: admin.organizationId,
      humanId: human,
      delegateId: delegate,
      entityType: "pull_request",
      entityKey: "owner/repo#502",
      chatId,
      boundVia: "direct",
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#502",
        actorLogin: "outsider",
        targets: [{ externalUsername: humanName, reason: "assigned" }],
        kind: "opened",
      }),
    );

    expect(audience).toHaveLength(1);
    expect(audience[0]?.kind).toBe("existing");
    expect(audience[0]?.chatId).toBe(chatId);
  });
});
