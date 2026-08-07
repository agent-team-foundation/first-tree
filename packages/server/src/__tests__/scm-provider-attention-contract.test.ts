import type { ScmIngressContext } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { createAgent } from "../services/agent.js";
import { resolveGithubAudience } from "../services/github-audience.js";
import { normalizeGithubWebhook } from "../services/github-normalize.js";
import { createGitlabConnection } from "../services/gitlab-connections.js";
import { createGitlabIdentityLink } from "../services/gitlab-identities.js";
import {
  applyGitlabPersonnelEvidence,
  normalizeGitlabWebhook,
  resolveGitlabAudience,
} from "../services/gitlab-webhook.js";
import {
  planScmChatDeliveries,
  type ScmAudienceTarget,
  scmWakeAgentIds,
  selectScmSenderId,
} from "../services/scm-chat-delivery-plan.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe.each(["github", "gitlab"] as const)("%s SCM attention conformance", (provider) => {
  it("routes an explicit line to one chat with its human sender and wake agent", async () => {
    const target: ScmAudienceTarget = {
      entry: {
        kind: "existing_line",
        line: {
          kind: "attention_line",
          humanAgentId: "human-1",
          wakeAgentId: "delegate-1",
          chatId: `${provider}-chat`,
          provenance: "explicit",
        },
      },
    };
    const planned = await planScmChatDeliveries({
      targets: [target],
      actorHumanId: null,
      resolveChat: async (candidate) => {
        if (candidate.entry.kind !== "existing_line") return null;
        return { chatId: candidate.entry.line.chatId, created: false };
      },
      onTargetError: () => {
        throw new Error("unexpected target error");
      },
    });
    const delivery = planned.deliveries.get(`${provider}-chat`);
    const entries = [...(delivery?.entries.values() ?? [])];
    expect(selectScmSenderId(entries)).toBe("human-1");
    expect(scmWakeAgentIds(entries)).toEqual(["delegate-1"]);
    expect(entries[0]?.reasons).toEqual(new Set(["follow"]));
  });
});

it("keeps an explicit legacy GitLab route silent without representing a nullable attention line", async () => {
  const planned = await planScmChatDeliveries({
    targets: [
      {
        entry: {
          kind: "legacy_route",
          route: {
            kind: "legacy_route_only",
            chatId: "legacy-chat",
            senderAgentId: "legacy-actor",
            wakeAgentId: null,
            provenance: "legacy_explicit",
          },
        },
      },
    ],
    actorHumanId: null,
    resolveChat: async () => ({ chatId: "legacy-chat", created: false }),
    onTargetError: () => {
      throw new Error("unexpected target error");
    },
  });
  const entries = [...(planned.deliveries.get("legacy-chat")?.entries.values() ?? [])];
  expect(selectScmSenderId(entries)).toBe("legacy-actor");
  expect(scmWakeAgentIds(entries)).toEqual([]);
});

it("keeps an actor-owned existing route as a silent card", async () => {
  const planned = await planScmChatDeliveries({
    targets: [
      {
        entry: {
          kind: "existing_line",
          line: {
            kind: "attention_line",
            humanAgentId: "actor-human",
            wakeAgentId: "actor-delegate",
            chatId: "actor-chat",
            provenance: "explicit",
          },
        },
      },
    ],
    actorHumanId: "actor-human",
    resolveChat: async () => ({ chatId: "actor-chat", created: false }),
    onTargetError: () => {
      throw new Error("unexpected target error");
    },
  });
  const entries = [...(planned.deliveries.get("actor-chat")?.entries.values() ?? [])];
  expect(entries).toHaveLength(1);
  expect(entries[0]?.wakeEligibility).toBe("actor_echo_suppressed");
  expect(scmWakeAgentIds(entries)).toEqual([]);
});

it("keeps one mixed-chat card and wakes only eligible sibling lines", async () => {
  const planned = await planScmChatDeliveries({
    targets: [
      {
        entry: {
          kind: "existing_line",
          line: {
            kind: "attention_line",
            humanAgentId: "actor-human",
            wakeAgentId: "actor-delegate",
            chatId: "shared-chat",
            provenance: "explicit",
          },
        },
      },
      {
        entry: {
          kind: "existing_line",
          line: {
            kind: "attention_line",
            humanAgentId: "other-human",
            wakeAgentId: "other-delegate",
            chatId: "shared-chat",
            provenance: "explicit",
          },
        },
      },
    ],
    actorHumanId: "actor-human",
    resolveChat: async () => ({ chatId: "shared-chat", created: false }),
    onTargetError: () => {
      throw new Error("unexpected target error");
    },
  });
  const entries = [...(planned.deliveries.get("shared-chat")?.entries.values() ?? [])];
  expect(entries).toHaveLength(2);
  expect(scmWakeAgentIds(entries)).toEqual(["other-delegate"]);
});

it("keeps a fresh self-directed personnel target wake-eligible", async () => {
  const planned = await planScmChatDeliveries({
    targets: [
      {
        entry: {
          kind: "personnel_target",
          humanAgentId: "actor-human",
          wakeAgentId: "actor-delegate",
          reason: "assigned",
          requiresPersistentLine: true,
          externalUsername: "actor",
        },
      },
    ],
    actorHumanId: "actor-human",
    resolveChat: async () => ({ chatId: "fresh-chat", created: true }),
    onTargetError: () => {
      throw new Error("unexpected target error");
    },
  });
  const entries = [...(planned.deliveries.get("fresh-chat")?.entries.values() ?? [])];
  expect(entries[0]?.wakeEligibility).toBe("eligible");
  expect(scmWakeAgentIds(entries)).toEqual(["actor-delegate"]);
});

describe("GitHub/GitLab semantic webhook conformance", () => {
  const getApp = useTestApp();
  const githubIngress: ScmIngressContext = {
    provider: "github",
    source: { organizationId: "org-1", externalId: "installation:1" },
    stableDeliveryId: null,
    ingressAuthority: "verified_signature",
  };

  it("normalizes code updates to the same semantic kind", () => {
    const github = normalizeGithubWebhook(
      "pull_request",
      {
        action: "synchronize",
        sender: { login: "author", type: "User" },
        repository: { full_name: "acme/api" },
        pull_request: {
          number: 7,
          title: "Update",
          html_url: "https://github.com/acme/api/pull/7",
          state: "open",
        },
      },
      githubIngress,
    );
    const gitlab = normalizeGitlabWebhook({
      organizationId: "org-1",
      connectionId: "connection-1",
      instanceOrigin: "https://gitlab.internal",
      stableDeliveryId: null,
      eventHeader: "Merge Request Hook",
      body: {
        object_kind: "merge_request",
        project: {
          id: 11,
          path_with_namespace: "acme/api",
          web_url: "https://gitlab.internal/acme/api",
        },
        user: { username: "author" },
        reviewers: [],
        object_attributes: {
          iid: 7,
          action: "update",
          oldrev: "abc123",
          title: "Update",
          url: "https://gitlab.internal/acme/api/-/merge_requests/7",
          state: "opened",
        },
      },
    });
    expect(github.event?.kind).toBe("synchronized");
    expect(gitlab.event?.kind).toBe(github.event?.kind);
  });

  it("normalizes ready-for-review to one reviewer wake target", () => {
    const github = normalizeGithubWebhook(
      "pull_request",
      {
        action: "ready_for_review",
        sender: { login: "author", type: "User" },
        repository: { full_name: "acme/api" },
        pull_request: {
          number: 8,
          title: "Ready",
          html_url: "https://github.com/acme/api/pull/8",
          state: "open",
          requested_reviewers: [{ login: "reviewer" }],
        },
      },
      githubIngress,
    );
    const gitlabRaw = normalizeGitlabWebhook({
      organizationId: "org-1",
      connectionId: "connection-1",
      instanceOrigin: "https://gitlab.internal",
      stableDeliveryId: null,
      eventHeader: "Merge Request Hook",
      body: {
        object_kind: "merge_request",
        project: {
          id: 11,
          path_with_namespace: "acme/api",
          web_url: "https://gitlab.internal/acme/api",
        },
        user: { username: "author" },
        reviewers: [{ username: "reviewer" }],
        changes: { draft: { previous: true, current: false } },
        object_attributes: {
          iid: 8,
          action: "update",
          draft: false,
          title: "Ready",
          url: "https://gitlab.internal/acme/api/-/merge_requests/8",
          state: "opened",
        },
      },
    });
    const gitlab = applyGitlabPersonnelEvidence(gitlabRaw, "reviewers");
    expect(github.event).toMatchObject({
      kind: "review_requested",
      targets: [{ externalUsername: "reviewer", reason: "review_requested" }],
    });
    expect(gitlab.event).toMatchObject({
      kind: "review_requested",
      targets: [{ externalUsername: "reviewer", reason: "review_requested" }],
    });
  });

  it("keeps assigned+mentioned parity through each provider audience adapter", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const delegate = await createAgent(app.db, {
      name: `parity-delegate-${admin.username}`,
      type: "agent",
      displayName: "Parity Delegate",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
    });
    await app.db.update(agents).set({ delegateMention: delegate.uuid }).where(eq(agents.uuid, admin.humanAgentUuid));
    const [human] = await app.db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.uuid, admin.humanAgentUuid))
      .limit(1);
    if (!human?.name) throw new Error("parity human login missing");
    const humanLogin = human.name;
    const connection = await createGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "Parity GitLab",
      instanceOrigin: "https://gitlab.internal",
    });
    await createGitlabIdentityLink(app.db, {
      organizationId: admin.organizationId,
      connectionId: connection.connectionId,
      membershipId: admin.memberId,
      username: humanLogin,
    });
    const github = normalizeGithubWebhook(
      "pull_request",
      {
        action: "opened",
        sender: { login: "author", type: "User" },
        repository: { full_name: "acme/api" },
        pull_request: {
          number: 10,
          title: "Shared priority",
          body: `Please review @${humanLogin}`,
          html_url: "https://github.com/acme/api/pull/10",
          state: "open",
          assignees: [{ login: humanLogin }],
        },
      },
      { ...githubIngress, source: { organizationId: admin.organizationId, externalId: "installation:1" } },
    );
    const gitlabRaw = normalizeGitlabWebhook({
      organizationId: admin.organizationId,
      connectionId: connection.connectionId,
      instanceOrigin: "https://gitlab.internal",
      stableDeliveryId: null,
      eventHeader: "Merge Request Hook",
      body: {
        object_kind: "merge_request",
        project: {
          id: 11,
          path_with_namespace: "acme/api",
          web_url: "https://gitlab.internal/acme/api",
        },
        user: { username: "author" },
        reviewers: [],
        assignees: [{ username: humanLogin }],
        object_attributes: {
          iid: 10,
          action: "open",
          description: `Please review @${humanLogin}`,
          title: "Shared priority",
          url: "https://gitlab.internal/acme/api/-/merge_requests/10",
          state: "opened",
        },
      },
    });
    const gitlab = applyGitlabPersonnelEvidence(gitlabRaw, "reviewers");
    if (!github.event || !gitlab.event || !gitlabRaw.entityIdentity) throw new Error("adapter parity event missing");
    expect(github.event?.targets).toEqual([
      { externalUsername: humanLogin.toLowerCase(), reason: "assigned" },
      { externalUsername: humanLogin.toLowerCase(), reason: "mentioned" },
    ]);
    expect(gitlab.event?.targets).toEqual([
      { externalUsername: humanLogin, reason: "assigned" },
      { externalUsername: humanLogin, reason: "mentioned" },
    ]);
    const githubAudience = await resolveGithubAudience(app.db, github.event);
    const gitlabAudience = await resolveGitlabAudience(app.db, {
      organizationId: admin.organizationId,
      connectionId: connection.connectionId,
      event: gitlab.event,
      entityIdentity: gitlabRaw.entityIdentity,
    });
    const project = <TProviderContext>(targets: ScmAudienceTarget<TProviderContext>[]) =>
      targets.map((target) => ({
        kind: target.entry.kind,
        reason: target.entry.kind === "personnel_target" ? target.entry.reason : target.directedContext?.reason,
        requiresPersistentLine:
          target.entry.kind === "personnel_target"
            ? target.entry.requiresPersistentLine
            : target.directedContext?.requiresPersistentLine,
        humanAgentId:
          target.entry.kind === "personnel_target" || target.entry.kind === "provider_task_target"
            ? target.entry.humanAgentId
            : target.entry.kind === "existing_line"
              ? target.entry.line.humanAgentId
              : null,
        wakeAgentId:
          target.entry.kind === "personnel_target" || target.entry.kind === "provider_task_target"
            ? target.entry.wakeAgentId
            : target.entry.kind === "existing_line"
              ? target.entry.line.wakeAgentId
              : null,
      }));
    const expected = [
      {
        kind: "personnel_target",
        reason: "mentioned",
        requiresPersistentLine: true,
        humanAgentId: admin.humanAgentUuid,
        wakeAgentId: delegate.uuid,
      },
    ];
    expect(project(githubAudience.targets)).toEqual(expected);
    expect(project(gitlabAudience.targets)).toEqual(expected);
  });

  it("normalizes terminal pull requests to observation-only merged state", () => {
    const github = normalizeGithubWebhook(
      "pull_request",
      {
        action: "closed",
        sender: { login: "author", type: "User" },
        repository: { full_name: "acme/api" },
        pull_request: {
          number: 9,
          title: "Merged",
          html_url: "https://github.com/acme/api/pull/9",
          state: "closed",
          merged: true,
        },
      },
      githubIngress,
    );
    const gitlab = normalizeGitlabWebhook({
      organizationId: "org-1",
      connectionId: "connection-1",
      instanceOrigin: "https://gitlab.internal",
      stableDeliveryId: null,
      eventHeader: "Merge Request Hook",
      body: {
        object_kind: "merge_request",
        project: {
          id: 11,
          path_with_namespace: "acme/api",
          web_url: "https://gitlab.internal/acme/api",
        },
        user: { username: "author" },
        reviewers: [],
        object_attributes: {
          iid: 9,
          action: "merge",
          title: "Merged",
          url: "https://gitlab.internal/acme/api/-/merge_requests/9",
          state: "merged",
        },
      },
    });
    expect(github).toMatchObject({ observation: { state: "merged" }, event: null });
    expect(gitlab).toMatchObject({ observation: { state: "merged" }, event: null });
  });
});
