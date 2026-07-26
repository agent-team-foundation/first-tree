import type { ScmIngressContext } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { normalizeGithubWebhook } from "../services/github-normalize.js";
import { applyGitlabPersonnelEvidence, normalizeGitlabWebhook } from "../services/gitlab-webhook.js";
import {
  planScmChatDeliveries,
  type ScmAudienceTarget,
  scmWakeAgentIds,
  selectScmSenderId,
} from "../services/scm-chat-delivery-plan.js";

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

describe("GitHub/GitLab semantic webhook conformance", () => {
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
