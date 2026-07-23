import { describe, expect, it } from "vitest";
import { buildClaimReadyGitlabDeliveryId } from "../services/gitlab-connections.js";
import {
  applyGitlabPersonnelEvidence,
  extractStableGitlabDeliveryId,
  MAX_GITLAB_PERSONNEL_TARGETS,
  normalizeGitlabWebhook,
} from "../services/gitlab-webhook.js";

const base = {
  organizationId: "org-1",
  connectionId: "connection-1",
  instanceOrigin: "https://gitlab.internal",
  stableDeliveryId: null,
};

function project() {
  return { id: 99, path_with_namespace: "Acme/API", web_url: "https://gitlab.internal/Acme/API" };
}

describe("GitLab webhook normalization", () => {
  it("classifies GitLab System Hook merge requests and ignores unrelated instance events", () => {
    const mr = normalizeGitlabWebhook({
      ...base,
      eventHeader: "System Hook",
      body: {
        object_kind: "merge_request",
        project: project(),
        user: { username: "alice" },
        reviewers: [],
        object_attributes: {
          iid: 7,
          action: "open",
          title: "System Hook MR",
          url: "https://gitlab.internal/Acme/API/-/merge_requests/7",
        },
      },
    });
    expect(mr.event).toMatchObject({
      eventType: "merge_request",
      kind: "opened",
      entity: { type: "pull_request", key: "99:pull_request:7" },
    });

    const repositoryUpdate = normalizeGitlabWebhook({
      ...base,
      eventHeader: "System Hook",
      body: { event_name: "repository_update", project_id: 99 },
    });
    expect(repositoryUpdate).toMatchObject({
      observation: null,
      event: null,
      entityIdentity: null,
    });
  });

  it("rejects missing or contradictory GitLab System Hook discriminators", () => {
    expect(() =>
      normalizeGitlabWebhook({
        ...base,
        eventHeader: "System Hook",
        body: {},
      }),
    ).toThrow("requires event_name or object_kind=merge_request");
    expect(() =>
      normalizeGitlabWebhook({
        ...base,
        eventHeader: "System Hook",
        body: { event_name: "repository_update", object_kind: "merge_request" },
      }),
    ).toThrow("event_name does not match object_kind");
  });

  it("normalizes merge request, issue, and note payloads without exposing raw provider fields", () => {
    const mr = normalizeGitlabWebhook({
      ...base,
      eventHeader: "Merge Request Hook",
      body: {
        object_kind: "merge_request",
        project: project(),
        user: { username: "alice" },
        reviewers: [],
        object_attributes: {
          iid: 7,
          action: "open",
          title: "Ship it",
          description: "Body",
          url: "https://gitlab.internal/Acme/API/-/merge_requests/7",
        },
      },
    });
    expect(mr.event).toMatchObject({
      provider: "gitlab",
      ingressAuthority: "url_bearer",
      kind: "opened",
      targets: [],
      entity: { type: "pull_request", projectKey: "99", key: "99:pull_request:7" },
    });
    expect(mr.personnel).toMatchObject({ reviewerField: "valid", reviewerAdded: [] });
    expect(mr.event).not.toHaveProperty("object_attributes");

    const issue = normalizeGitlabWebhook({
      ...base,
      eventHeader: "Issue Hook",
      body: {
        object_kind: "issue",
        project: project(),
        user: { username: "bob" },
        object_attributes: {
          iid: 8,
          action: "reopen",
          title: "Bug",
          url: "https://gitlab.internal/Acme/API/-/issues/8",
        },
      },
    });
    expect(issue.event).toMatchObject({ kind: "reopened", entity: { type: "issue", key: "99:issue:8" } });

    const note = normalizeGitlabWebhook({
      ...base,
      eventHeader: "Note Hook",
      body: {
        object_kind: "note",
        project: project(),
        user: { username: "carol" },
        object_attributes: { noteable_type: "Issue", note: "hello @Reviewer.One", action: "create" },
        issue: {
          iid: 8,
          title: "Bug",
          description: "parent issue description",
          url: "https://gitlab.internal/Acme/API/-/issues/8",
        },
      },
    });
    expect(note.event).toMatchObject({
      kind: "commented",
      surface: { body: "hello @Reviewer.One" },
      entity: { type: "issue" },
    });
    expect(note.personnel.mentions).toEqual(["Reviewer.One"]);
    expect(note.observation?.state).toBeNull();

    const editedNote = normalizeGitlabWebhook({
      ...base,
      eventHeader: "Note Hook",
      body: {
        object_kind: "note",
        project: project(),
        user: { username: "carol" },
        object_attributes: { noteable_type: "Issue", note: "edited comment", action: "update" },
        issue: {
          iid: 8,
          title: "Bug",
          description: "parent issue description",
          url: "https://gitlab.internal/Acme/API/-/issues/8",
        },
      },
    });
    expect(editedNote.event).toMatchObject({ kind: "edited", surface: { body: "edited comment" } });
  });

  it("separates MR observation from semantic delivery and preserves actionable deltas", () => {
    const normalizeMr = (objectAttributes: Record<string, unknown>, changes?: Record<string, unknown>) =>
      normalizeGitlabWebhook({
        ...base,
        eventHeader: "Merge Request Hook",
        body: {
          object_kind: "merge_request",
          project: project(),
          user: { username: "alice" },
          reviewers: [{ username: "Reviewer.One" }],
          assignees: [],
          object_attributes: {
            iid: 27,
            title: "Envelope",
            description: "Resolves #12 and `fixes #99`",
            url: "https://gitlab.internal/Acme/API/-/merge_requests/27",
            ...objectAttributes,
          },
          ...(changes ? { changes } : {}),
        },
      });

    const synchronized = normalizeMr({ action: "update", oldrev: "abc123", state: "opened" });
    expect(synchronized).toMatchObject({
      observation: { state: "open", entity: { key: "99:pull_request:27" } },
      event: { kind: "synchronized" },
    });

    const metadataOnly = normalizeMr(
      { action: "update", state: "opened" },
      { labels: { previous: [], current: [{ title: "backend" }] } },
    );
    expect(metadataOnly.observation?.state).toBe("open");
    expect(metadataOnly.event).toBeNull();

    const closed = normalizeMr({ action: "close", state: "closed" });
    expect(closed.observation?.state).toBe("closed");
    expect(closed.event).toBeNull();

    const merged = normalizeMr({ action: "merge", state: "merged" });
    expect(merged.observation?.state).toBe("merged");
    expect(merged.event).toBeNull();

    const ready = normalizeMr(
      { action: "update", draft: false, state: "opened" },
      { draft: { previous: true, current: false } },
    );
    expect(ready.observation?.state).toBe("open");
    expect(ready.event?.kind).toBe("review_requested");
    expect(applyGitlabPersonnelEvidence(ready, "reviewers").event?.targets).toEqual([
      { externalUsername: "Reviewer.One", reason: "review_requested" },
    ]);

    const description = normalizeMr(
      {
        action: "update",
        description: "Fixes #12, closes #12, resolves group/other#8 and ping @Target.One",
      },
      {
        description: {
          previous: "old",
          current: "Fixes #12, closes #12, resolves group/other#8 and ping @Target.One",
        },
      },
    );
    expect(description.event).toMatchObject({
      kind: "edited",
      relatedRefs: [{ type: "issue", key: "99:issue:12" }],
    });
    expect(description.personnel.mentions).toEqual(["Target.One"]);
  });

  it("normalizes Issue lifecycle while dropping metadata-only updates", () => {
    const normalizeIssue = (action: string, changes?: Record<string, unknown>) =>
      normalizeGitlabWebhook({
        ...base,
        eventHeader: "Issue Hook",
        body: {
          object_kind: "issue",
          project: project(),
          user: { username: "alice" },
          object_attributes: {
            iid: 31,
            action,
            title: "Issue envelope",
            description: "hello",
            url: "https://gitlab.internal/Acme/API/-/issues/31",
          },
          ...(changes ? { changes } : {}),
        },
      });

    expect(normalizeIssue("open")).toMatchObject({ observation: { state: "open" }, event: { kind: "opened" } });
    expect(normalizeIssue("close")).toMatchObject({
      observation: { state: "closed" },
      event: { kind: "closed" },
    });
    expect(normalizeIssue("reopen")).toMatchObject({
      observation: { state: "open" },
      event: { kind: "reopened" },
    });
    const labelOnly = normalizeIssue("update", { labels: { previous: [], current: [] } });
    expect(labelOnly.observation?.state).toBe("open");
    expect(labelOnly.event).toBeNull();
  });

  it("extracts personnel targets only from open and update actions", () => {
    const mr = (action: string | undefined, reviewerCount = 1) =>
      normalizeGitlabWebhook({
        ...base,
        eventHeader: "Merge Request Hook",
        body: {
          object_kind: "merge_request",
          project: project(),
          user: { username: "alice" },
          reviewers: Array.from({ length: reviewerCount }, (_, index) => ({ username: `reviewer${index}` })),
          assignees: [{ username: "assignee" }],
          object_attributes: {
            iid: 17,
            ...(action === undefined ? {} : { action }),
            title: "Action semantics",
          },
        },
      });
    for (const action of ["close", "reopen", "merge"] as const) {
      expect(mr(action).personnel).toMatchObject({
        reviewerField: "valid",
        reviewerAdded: [],
        assigneeAdded: [],
      });
    }
    expect(mr(undefined).personnel).toMatchObject({
      reviewerField: "valid",
      reviewerAdded: [],
      assigneeAdded: [],
    });
    expect(mr("close", MAX_GITLAB_PERSONNEL_TARGETS + 1).personnel).toMatchObject({
      reviewerField: "valid",
      reviewerAdded: [],
    });

    for (const action of ["close", "reopen", undefined] as const) {
      const issue = normalizeGitlabWebhook({
        ...base,
        eventHeader: "Issue Hook",
        body: {
          object_kind: "issue",
          project: project(),
          user: { username: "alice" },
          assignees: [{ username: "assignee" }],
          object_attributes: {
            iid: 18,
            ...(action === undefined ? {} : { action }),
            title: "Issue action semantics",
          },
        },
      });
      expect(issue.personnel.assigneeAdded).toEqual([]);
    }
  });

  it("returns an authenticated no-op for unsupported event kinds", () => {
    const result = normalizeGitlabWebhook({ ...base, eventHeader: "Push Hook", body: { object_kind: "push" } });
    expect(result.event).toBeNull();
  });

  it("fails closed on event/body mismatch and records malformed reviewer evidence for safe-card handling", () => {
    expect(() =>
      normalizeGitlabWebhook({ ...base, eventHeader: "Issue Hook", body: { object_kind: "merge_request" } }),
    ).toThrow("does not match");
    const malformedReviewers = normalizeGitlabWebhook({
      ...base,
      eventHeader: "Merge Request Hook",
      body: {
        object_kind: "merge_request",
        project: project(),
        user: { username: "alice" },
        reviewers: null,
        object_attributes: { iid: 1 },
      },
    });
    expect(malformedReviewers.personnel).toMatchObject({
      reviewerField: "invalid",
      anomalyCode: "reviewers_wrong_type",
    });
    expect(() =>
      normalizeGitlabWebhook({
        ...base,
        eventHeader: "Issue Hook",
        body: {
          object_kind: "issue",
          project: project(),
          user: { name: "Alice Display Name" },
          object_attributes: { iid: 1, title: "Issue" },
        },
      }),
    ).toThrow("user.username");
    expect(() =>
      normalizeGitlabWebhook({
        ...base,
        eventHeader: "Issue Hook",
        body: {
          object_kind: "issue",
          project: { ...project(), web_url: "http://169.254.169.254/latest" },
          user: { username: "alice" },
          object_attributes: { iid: 1, url: "javascript:alert(1)" },
        },
      }),
    ).toThrow("connection's GitLab origin");
  });

  it("caps reviewer, assignee, mention, and deduplicated total personnel targets before processing", () => {
    const users = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({ username: `${prefix}${index}` }));
    const mr = (reviewers: unknown, assignees: unknown = []) => ({
      object_kind: "merge_request",
      project: project(),
      user: { username: "alice" },
      reviewers,
      assignees,
      object_attributes: { iid: 11, action: "open", title: "Bounded targets" },
    });
    expect(() =>
      normalizeGitlabWebhook({
        ...base,
        eventHeader: "Merge Request Hook",
        body: mr(users("reviewer", MAX_GITLAB_PERSONNEL_TARGETS + 1)),
      }),
    ).toThrow("must not exceed");
    expect(() =>
      normalizeGitlabWebhook({
        ...base,
        eventHeader: "Merge Request Hook",
        body: mr(users("reviewer", 30), users("assignee", 21)),
      }),
    ).toThrow("must not exceed");
    expect(
      normalizeGitlabWebhook({
        ...base,
        eventHeader: "Merge Request Hook",
        body: mr(users("reviewer", MAX_GITLAB_PERSONNEL_TARGETS)),
      }).personnel.reviewerAdded,
    ).toHaveLength(MAX_GITLAB_PERSONNEL_TARGETS);

    expect(() =>
      normalizeGitlabWebhook({
        ...base,
        eventHeader: "Issue Hook",
        body: {
          object_kind: "issue",
          project: project(),
          user: { username: "alice" },
          assignees: users("assignee", MAX_GITLAB_PERSONNEL_TARGETS + 1),
          object_attributes: { iid: 12, action: "open", title: "Bounded assignees" },
        },
      }),
    ).toThrow("must not exceed");

    expect(() =>
      normalizeGitlabWebhook({
        ...base,
        eventHeader: "Note Hook",
        body: {
          object_kind: "note",
          project: project(),
          user: { username: "alice" },
          object_attributes: {
            noteable_type: "Issue",
            note: users("mentioned", MAX_GITLAB_PERSONNEL_TARGETS + 1)
              .map((user) => `@${user.username}`)
              .join(" "),
            action: "create",
          },
          issue: { iid: 13, title: "Bounded mentions" },
        },
      }),
    ).toThrow("must not exceed");
  });

  it("scopes stable upstream ids by connection", () => {
    const a = buildClaimReadyGitlabDeliveryId("connection-a", "same-upstream-id");
    const b = buildClaimReadyGitlabDeliveryId("connection-b", "same-upstream-id");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^connection-a:/);
    expect(b).toMatch(/^connection-b:/);
  });

  it("claims only retry-stable delivery headers and requires modern headers to agree", () => {
    const expected = buildClaimReadyGitlabDeliveryId("connection-1", "delivery-1");
    expect(extractStableGitlabDeliveryId({ "idempotency-key": "delivery-1" }, "connection-1")).toBe(expected);
    expect(extractStableGitlabDeliveryId({ "webhook-id": "delivery-1" }, "connection-1")).toBe(expected);
    expect(
      extractStableGitlabDeliveryId({ "idempotency-key": "delivery-1", "webhook-id": "delivery-1" }, "connection-1"),
    ).toBe(expected);
    expect(extractStableGitlabDeliveryId({ "x-gitlab-webhook-uuid": "request-only-uuid" }, "connection-1")).toBeNull();
    expect(() =>
      extractStableGitlabDeliveryId({ "idempotency-key": "delivery-1", "webhook-id": "delivery-2" }, "connection-1"),
    ).toThrow("must match");
  });
});
