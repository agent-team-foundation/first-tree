import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { gitlabIdentityLinks } from "../db/schema/gitlab-identity-links.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { createAgent, suspendAgent, updateAgent } from "../services/agent.js";
import { createChat } from "../services/chat.js";
import {
  createGitlabConnection,
  findActiveGitlabEndpoint,
  withGitlabIngressFence,
} from "../services/gitlab-connections.js";
import { declareGitlabEntityFollow } from "../services/gitlab-entity-follow.js";
import {
  createGitlabIdentityLink,
  reconfirmGitlabIdentityLink,
  removeGitlabIdentityLink,
  suspendGitlabLinksForMembership,
} from "../services/gitlab-identities.js";
import {
  applyGitlabPersonnelEvidence,
  deliverGitlabCards,
  normalizeGitlabWebhook,
  resolveGitlabAudience,
} from "../services/gitlab-webhook.js";
import { deactivateMembership, MEMBER_STATUSES } from "../services/membership.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

function mrPayload(reviewers: { username: string }[], actor = "author", iid = 31) {
  return {
    object_kind: "merge_request",
    project: {
      id: 941,
      path_with_namespace: "Acme/Fenced",
      web_url: "https://gitlab.internal/Acme/Fenced",
    },
    user: { username: actor },
    reviewers,
    object_attributes: {
      iid,
      action: "open",
      title: "Fence identity authority",
      url: `https://gitlab.internal/Acme/Fenced/-/merge_requests/${iid}`,
      state: "opened",
    },
  };
}

function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup(app: App) {
  const admin = await createTestAdmin(app, { username: `identity-fence-${randomUUID().slice(0, 8)}` });
  const delegate = await createAgent(app.db, {
    name: `identity-fence-agent-${randomUUID().slice(0, 8)}`,
    type: "agent",
    displayName: "Identity Fence Agent",
    managerId: admin.memberId,
    organizationId: admin.organizationId,
  });
  await app.db.update(agents).set({ delegateMention: delegate.uuid }).where(eq(agents.uuid, admin.humanAgentUuid));
  const connection = await createGitlabConnection(app.db, {
    organizationId: admin.organizationId,
    memberId: admin.memberId,
    displayName: "Fenced GitLab",
    instanceOrigin: "https://gitlab.internal",
  });
  const link = await createGitlabIdentityLink(app.db, {
    organizationId: admin.organizationId,
    connectionId: connection.connectionId,
    membershipId: admin.memberId,
    username: "Reviewer.One",
  });
  return { admin, delegate, connection, link };
}

async function postMr(app: App, bearer: string, reviewers: { username: string }[]) {
  return app.inject({
    method: "POST",
    url: `/api/v1/webhooks/gitlab/${bearer}`,
    headers: { "content-type": "application/json", "x-gitlab-event": "System Hook" },
    payload: JSON.stringify(mrPayload(reviewers)),
  });
}

async function holdIngressAfterDurableCard(
  app: App,
  fixture: Awaited<ReturnType<typeof setup>>,
  reviewers: { username: string }[],
  entered: () => void,
  release: Promise<void>,
) {
  const endpoint = await findActiveGitlabEndpoint(app.db, fixture.connection.bearer);
  if (!endpoint) throw new Error("GitLab endpoint missing");
  const normalized = normalizeGitlabWebhook({
    organizationId: fixture.admin.organizationId,
    connectionId: fixture.connection.connectionId,
    instanceOrigin: "https://gitlab.internal",
    stableDeliveryId: null,
    eventHeader: "System Hook",
    body: mrPayload(reviewers),
  });
  const applied = applyGitlabPersonnelEvidence(normalized, "reviewers");
  const identity = normalized.entityIdentity;
  const event = applied.event;
  if (!identity || !event) throw new Error("normalized MR missing");
  return withGitlabIngressFence(app.db, fixture.connection.connectionId, endpoint.connection.tokenHash, async (tx) => {
    const audience = await resolveGitlabAudience(tx, {
      organizationId: fixture.admin.organizationId,
      connectionId: fixture.connection.connectionId,
      event,
      entityIdentity: identity,
    });
    const delivery = await deliverGitlabCards(app, {
      event,
      identity,
      audience,
      organizationId: fixture.admin.organizationId,
      connectionId: fixture.connection.connectionId,
      database: tx,
    });
    entered();
    await release;
    return delivery.postCommitEffects;
  });
}

describe("GitLab identity authority fencing", () => {
  const getApp = useTestApp();

  it.each([
    { boundVia: "human_declared" as const, transition: "remove" as const },
    { boundVia: "agent_declared" as const, transition: "member_leave" as const },
  ])("fences an explicit $boundVia actor against $transition", async ({ boundVia, transition }) => {
    const app = getApp();
    const fixture = await setup(app);
    if (transition === "member_leave") {
      await createTestAdmin(app, { username: `actor-fence-fallback-${randomUUID().slice(0, 8)}` });
    }
    const iid = transition === "remove" ? 71 : 72;
    const chat = await createChat(app.db, fixture.admin.humanAgentUuid, {
      type: "group",
      participantIds: [fixture.delegate.uuid],
      topic: `Actor fence ${iid}`,
      metadata: {},
    });
    await declareGitlabEntityFollow(app.db, {
      organizationId: fixture.admin.organizationId,
      connectionId: fixture.connection.connectionId,
      chatId: chat.id,
      declaredByAgentId: boundVia === "human_declared" ? fixture.admin.humanAgentUuid : fixture.delegate.uuid,
      humanAgentId: fixture.admin.humanAgentUuid,
      delegateAgentId: fixture.delegate.uuid,
      boundVia,
      entityUrl: `https://gitlab.internal/Acme/Fenced/-/merge_requests/${iid}`,
    });
    const endpoint = await findActiveGitlabEndpoint(app.db, fixture.connection.bearer);
    if (!endpoint) throw new Error("GitLab endpoint missing");
    const normalized = normalizeGitlabWebhook({
      organizationId: fixture.admin.organizationId,
      connectionId: fixture.connection.connectionId,
      instanceOrigin: "https://gitlab.internal",
      stableDeliveryId: null,
      eventHeader: "System Hook",
      body: mrPayload([], "Reviewer.One", iid),
    });
    const applied = applyGitlabPersonnelEvidence(normalized, "reviewers");
    const entityIdentity = normalized.entityIdentity;
    const event = applied.event;
    if (!entityIdentity || !event) throw new Error("normalized actor MR missing");

    const entered = deferredSignal();
    const release = deferredSignal();
    const ingress = withGitlabIngressFence(
      app.db,
      fixture.connection.connectionId,
      endpoint.connection.tokenHash,
      async (tx) => {
        const audience = await resolveGitlabAudience(tx, {
          organizationId: fixture.admin.organizationId,
          connectionId: fixture.connection.connectionId,
          event,
          entityIdentity,
        });
        expect(audience.actorHumanId).toBe(fixture.admin.humanAgentUuid);
        entered.resolve();
        await release.promise;
        return deliverGitlabCards(app, {
          event,
          identity: entityIdentity,
          audience,
          organizationId: fixture.admin.organizationId,
          connectionId: fixture.connection.connectionId,
          database: tx,
        });
      },
    );
    await entered.promise;

    let transitionSettled = false;
    const transitionPromise = (
      transition === "remove"
        ? removeGitlabIdentityLink(app.db, {
            organizationId: fixture.admin.organizationId,
            linkId: fixture.link.id,
          })
        : deactivateMembership(app.db, fixture.admin.memberId, MEMBER_STATUSES.LEFT)
    ).then(() => {
      transitionSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(transitionSettled).toBe(false);

    release.resolve();
    await ingress;
    await transitionPromise;
    expect(
      await app.db
        .select()
        .from(messages)
        .where(and(eq(messages.chatId, chat.id), eq(messages.source, "gitlab"))),
    ).toHaveLength(0);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/gitlab/${fixture.connection.bearer}`,
      headers: { "content-type": "application/json", "x-gitlab-event": "System Hook" },
      payload: JSON.stringify(mrPayload([], "Reviewer.One", iid)),
    });
    expect(response.statusCode).toBe(200);
    expect(
      await app.db
        .select()
        .from(messages)
        .where(and(eq(messages.chatId, chat.id), eq(messages.source, "gitlab"))),
    ).toHaveLength(1);
  }, 20_000);

  it.each([
    { transition: "remove" as const, existing: true },
    { transition: "remove" as const, existing: false },
    { transition: "leave" as const, existing: true },
    { transition: "leave" as const, existing: false },
  ])("serializes $transition against an in-flight $existing identity route", async ({ transition, existing }) => {
    const app = getApp();
    const fixture = await setup(app);
    if (transition === "leave") {
      await createTestAdmin(app, { username: `identity-fence-fallback-${randomUUID().slice(0, 8)}` });
    }
    if (existing) {
      expect((await postMr(app, fixture.connection.bearer, [{ username: "Reviewer.One" }])).statusCode).toBe(200);
    }

    let signalEntered!: () => void;
    let signalRelease!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      signalRelease = resolve;
    });
    const ingress = holdIngressAfterDurableCard(
      app,
      fixture,
      existing ? [] : [{ username: "Reviewer.One" }],
      signalEntered,
      release,
    );
    await entered;

    let transitionSettled = false;
    const transitionPromise = (async () => {
      if (transition === "remove") {
        await removeGitlabIdentityLink(app.db, {
          organizationId: fixture.admin.organizationId,
          linkId: fixture.link.id,
        });
      } else {
        await deactivateMembership(app.db, fixture.admin.memberId, MEMBER_STATUSES.LEFT);
      }
      transitionSettled = true;
    })();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(transitionSettled).toBe(false);

    signalRelease();
    await ingress;
    await transitionPromise;
    const [link] = await app.db.select().from(gitlabIdentityLinks).where(eq(gitlabIdentityLinks.id, fixture.link.id));
    if (transition === "remove") expect(link).toBeUndefined();
    else expect(link?.state).toBe("suspended");
    const activeMappings = await app.db
      .select()
      .from(gitlabEntityChatMappings)
      .where(
        and(eq(gitlabEntityChatMappings.identityLinkId, fixture.link.id), eq(gitlabEntityChatMappings.active, true)),
      );
    expect(activeMappings).toHaveLength(0);
  }, 20_000);

  it.each([
    { transition: "delegate_change" as const, existing: true },
    { transition: "delegate_change" as const, existing: false },
    { transition: "delegate_suspend" as const, existing: true },
    { transition: "delegate_suspend" as const, existing: false },
  ])("serializes $transition against an in-flight $existing identity route", async ({ transition, existing }) => {
    const app = getApp();
    const fixture = await setup(app);
    const replacement = await createAgent(app.db, {
      name: `identity-fence-replacement-${randomUUID().slice(0, 8)}`,
      type: "agent",
      displayName: "Replacement Identity Fence Agent",
      managerId: fixture.admin.memberId,
      organizationId: fixture.admin.organizationId,
    });
    if (existing) {
      expect((await postMr(app, fixture.connection.bearer, [{ username: "Reviewer.One" }])).statusCode).toBe(200);
    }

    let signalEntered!: () => void;
    let signalRelease!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      signalRelease = resolve;
    });
    const ingress = holdIngressAfterDurableCard(
      app,
      fixture,
      existing ? [] : [{ username: "Reviewer.One" }],
      signalEntered,
      release,
    );
    await entered;

    let transitionSettled = false;
    const transitionPromise = (
      transition === "delegate_change"
        ? updateAgent(app.db, fixture.admin.humanAgentUuid, { delegateMention: replacement.uuid })
        : suspendAgent(app.db, fixture.delegate.uuid)
    ).then(() => {
      transitionSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(transitionSettled).toBe(false);

    signalRelease();
    await ingress;
    await transitionPromise;
    if (transition === "delegate_change") {
      const [human] = await app.db
        .select({ delegateMention: agents.delegateMention })
        .from(agents)
        .where(eq(agents.uuid, fixture.admin.humanAgentUuid));
      expect(human?.delegateMention).toBe(replacement.uuid);
    } else {
      const [delegate] = await app.db
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.uuid, fixture.delegate.uuid));
      expect(delegate?.status).toBe("suspended");
    }
  }, 20_000);

  it("keeps reconfirm and member leave on connection → membership → link ordering", async () => {
    const app = getApp();
    const fixture = await setup(app);
    await createTestAdmin(app, { username: `identity-lock-fallback-${randomUUID().slice(0, 8)}` });
    await suspendGitlabLinksForMembership(app.db, fixture.admin.memberId);

    let membershipLocked!: () => void;
    let continueLeave!: () => void;
    const locked = new Promise<void>((resolve) => {
      membershipLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      continueLeave = resolve;
    });
    const leaving = app.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      await rawTx.select().from(members).where(eq(members.id, fixture.admin.memberId)).for("update").limit(1);
      membershipLocked();
      await release;
      await rawTx.update(members).set({ status: MEMBER_STATUSES.LEFT }).where(eq(members.id, fixture.admin.memberId));
      await suspendGitlabLinksForMembership(tx, fixture.admin.memberId);
    });
    await locked;

    let reconfirmSettled = false;
    const reconfirming = reconfirmGitlabIdentityLink(app.db, {
      organizationId: fixture.admin.organizationId,
      linkId: fixture.link.id,
    }).then(
      () => {
        reconfirmSettled = true;
        return null;
      },
      (error: unknown) => {
        reconfirmSettled = true;
        return error;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(reconfirmSettled).toBe(false);
    continueLeave();
    await leaving;
    const result = await reconfirming;
    expect(result).toMatchObject({ message: expect.stringContaining("active membership") });
  }, 20_000);
});
