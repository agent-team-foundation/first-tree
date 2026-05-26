import { randomUUID } from "node:crypto";
import type { NormalizedEvent } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { identifyActor, resolveAudience } from "../services/github-audience.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

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
  },
): Promise<void> {
  await app.db.insert(githubEntityChatMappings).values({
    organizationId: opts.orgId,
    humanAgentId: opts.humanId,
    delegateAgentId: opts.delegateId,
    entityType: opts.entityType,
    entityKey: opts.entityKey,
    chatId: opts.chatId,
    boundVia: "direct",
  });
}

function makeEvent(opts: {
  orgId: string;
  installationId?: number;
  entityType: "issue" | "pull_request" | "discussion" | "commit";
  entityKey: string;
  actorLogin: string;
  actorIsBot?: boolean;
  involves?: Array<{ githubLogin: string; reason: "mentioned" | "review_requested" | "assigned" }>;
  kind?: NormalizedEvent["kind"];
}): NormalizedEvent {
  return {
    source: {
      kind: "github-app-installation",
      installationId: opts.installationId ?? 1,
      organizationId: opts.orgId,
    },
    deliveryId: "delivery-1",
    rawEventType: "pull_request",
    rawAction: "opened",
    entity: {
      type: opts.entityType,
      repo: "owner/repo",
      key: opts.entityKey,
      title: "X",
      url: "https://github.com/owner/repo",
    },
    actor: { githubLogin: opts.actorLogin, isBot: opts.actorIsBot ?? false },
    kind: opts.kind ?? "opened",
    involves: opts.involves ?? [],
    surface: { title: "X", body: "", url: "" },
    relatedRefs: [],
  };
}

describe("identifyActor", () => {
  const getApp = useTestApp();

  it("returns our-app-bot when the sender login matches `<slug>[bot]` (case-insensitive)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const id = await identifyActor(
      app.db,
      admin.organizationId,
      { githubLogin: "First-Tree[bot]", isBot: true },
      "first-tree",
    );
    expect(id).toEqual({ kind: "our-app-bot" });
  });

  it("falls through to external when isBot is true but the slug does NOT match", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const id = await identifyActor(
      app.db,
      admin.organizationId,
      { githubLogin: "dependabot[bot]", isBot: true },
      "first-tree",
    );
    expect(id).toEqual({ kind: "external" });
  });

  it("returns external when appSlug is null even for bot senders", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const id = await identifyActor(app.db, admin.organizationId, { githubLogin: "first-tree[bot]", isBot: true }, null);
    expect(id).toEqual({ kind: "external" });
  });

  it("returns agent identity when the sender login matches an org agent (case-insensitive)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const agentId = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `alice-${randomUUID().slice(0, 6)}`,
    });
    const [row] = await app.db.select({ name: agents.name }).from(agents).where(eq(agents.uuid, agentId)).limit(1);
    if (!row?.name) throw new Error("seeded agent has no name");
    const id = await identifyActor(
      app.db,
      admin.organizationId,
      { githubLogin: row.name.toUpperCase(), isBot: false },
      "first-tree",
    );
    expect(id).toEqual({ kind: "agent", agentId });
  });

  it("returns external for unknown senders", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const id = await identifyActor(
      app.db,
      admin.organizationId,
      { githubLogin: "stranger", isBot: false },
      "first-tree",
    );
    expect(id).toEqual({ kind: "external" });
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
      "first-tree",
    );

    expect(audience).toEqual([
      {
        humanAgentId: humanA,
        delegateAgentId: delegateA,
        kind: "existing",
        chatId,
        involveReason: null,
        involveLogin: null,
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
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#101",
        actorLogin: "outsider",
        involves: [{ githubLogin: humanName, reason: "review_requested" }],
        kind: "review_requested",
      }),
      "first-tree",
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

  it("subscribed + involved union; subscribed wins de-dup (existing kept over new)", async () => {
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
        involves: [{ githubLogin: humanName, reason: "mentioned" }],
        kind: "commented",
      }),
      "first-tree",
    );

    expect(audience).toHaveLength(1);
    expect(audience[0]?.kind).toBe("existing");
    expect(audience[0]?.chatId).toBe(chatId);
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
      "first-tree",
    );

    expect(audience).toHaveLength(1);
    expect(audience[0]?.kind).toBe("existing");
    expect(audience[0]?.humanAgentId).toBe(human);
    expect(audience[0]?.chatId).toBe(chatId);
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
        involves: [{ githubLogin: humanName, reason: "assigned" }],
        kind: "assigned",
      }),
      "first-tree",
    );

    expect(audience).toHaveLength(1);
    expect(audience[0]?.kind).toBe("existing");
    expect(audience[0]?.delegateAgentId).toBe(delegateA);
    expect(audience[0]?.chatId).toBe(chatId);
  });

  it("keeps subscribed targets when actor is our-app-bot (route Hub's own writes back to existing chats)", async () => {
    // Background: when an agent creates a PR via Hub's GitHub App token, the
    // resulting `pull_request.opened` webhook arrives with `sender = <app>[bot]`.
    // Pre-agent-binding behaviour silenced the whole audience here, which
    // meant PR comments / CI changes on bot-authored entities never reached
    // the chat the agent worked in. The new behaviour keeps `kind: "existing"`
    // rows so subscribed chats still get the event; `kind: "new"` rows are
    // dropped because minting a fresh chat just to echo our own write is
    // never useful.
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
      "first-tree",
    );

    expect(audience).toHaveLength(1);
    expect(audience[0]?.kind).toBe("existing");
    expect(audience[0]?.chatId).toBe(chatId);
  });

  it("drops mention-only targets when actor is our-app-bot (no fresh chat for our own write)", async () => {
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
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#104",
        actorLogin: "first-tree[bot]",
        actorIsBot: true,
        involves: [{ githubLogin: humanName, reason: "mentioned" }],
        kind: "opened",
      }),
      "first-tree",
    );

    expect(audience).toEqual([]);
  });

  it("echo: drops mappings where actor is the human side OR delegate side", async () => {
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
    });
    const otherHuman = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: `human-other-${randomUUID().slice(0, 6)}`,
      delegateMention: otherDelegate,
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

    // Actor is the human-side agent → only the other-human row survives.
    const [humanRow] = await app.db.select({ name: agents.name }).from(agents).where(eq(agents.uuid, human)).limit(1);
    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#104",
        actorLogin: humanRow?.name ?? "",
        kind: "synchronized",
      }),
      "first-tree",
    );
    expect(audience).toHaveLength(1);
    expect(audience[0]?.humanAgentId).toBe(otherHuman);
  });

  it("keeps an involved-new row when actor self-mentions (explicit intent, not echo)", async () => {
    // Regression test for #345: the legacy mention-driven webhook routed
    // self-mentions to the actor's own delegate. The normalize → audience
    // pipeline accidentally suppressed this because `identifyActor` classifies
    // any actor with an agents-row as `kind: "agent"`, and the echo filter
    // dropped all rows touching that agent — including the brand-new mention.
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
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "issue",
        entityKey: "owner/repo#108",
        actorLogin: humanName,
        involves: [{ githubLogin: humanName, reason: "mentioned" }],
        kind: "commented",
      }),
      "first-tree",
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

  it("self-mention in an already-subscribed entity stays silent (existing dropped, new skipped by subscribedKeys)", async () => {
    // Documents the interaction between two filters when actor self-targets
    // an entity they already subscribe to:
    //   - the `subscribedKeys` short-circuit (resolveAudience) skips adding a
    //     `kind: "new"` row because (human, delegate) is already subscribed
    //   - the actor-agent echo filter then drops the surviving `kind: "existing"`
    //     row because the actor is on the human side
    // Net result: audience is empty. This is *not* the explicit-intent path the
    // sibling test covers — there's no new row to keep. Locking the behavior
    // here so a future change that wants to nudge a subscribed delegate via
    // self-mention has a clear anchor.
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
        involves: [{ githubLogin: humanName, reason: "mentioned" }],
        kind: "commented",
      }),
      "first-tree",
    );

    expect(audience).toEqual([]);
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
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#105",
        actorLogin: "outsider",
        involves: [{ githubLogin: humanInactiveName, reason: "mentioned" }],
        kind: "opened",
      }),
      "first-tree",
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
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#106",
        actorLogin: "outsider",
        involves: [{ githubLogin: humanName, reason: "mentioned" }],
        kind: "opened",
      }),
      "first-tree",
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
    });
    const carol = await seedAgent(app, {
      orgId: admin.organizationId,
      memberId: admin.memberId,
      name: carolName,
      delegateMention: delegateCarol,
    });

    const audience = await resolveAudience(
      app.db,
      makeEvent({
        orgId: admin.organizationId,
        entityType: "pull_request",
        entityKey: "owner/repo#107",
        actorLogin: "outsider",
        involves: [
          { githubLogin: bobName, reason: "mentioned" },
          { githubLogin: carolName, reason: "mentioned" },
        ],
        kind: "opened",
      }),
      "first-tree",
    );

    expect(audience).toHaveLength(2);
    const bobTarget = audience.find((a) => a.humanAgentId === bob);
    const carolTarget = audience.find((a) => a.humanAgentId === carol);
    expect(bobTarget?.involveLogin).toBe(bobName.toLowerCase());
    expect(bobTarget?.involveReason).toBe("mentioned");
    expect(carolTarget?.involveLogin).toBe(carolName.toLowerCase());
    expect(carolTarget?.involveReason).toBe("mentioned");
  });
});
