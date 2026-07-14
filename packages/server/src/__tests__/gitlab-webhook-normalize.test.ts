import { describe, expect, it } from "vitest";
import { buildClaimReadyGitlabDeliveryId } from "../services/gitlab-connections.js";
import { extractStableGitlabDeliveryId, normalizeGitlabWebhook } from "../services/gitlab-webhook.js";

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
    expect(mr.reviewerCapability).toBe("reviewers");
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
        object_attributes: { noteable_type: "Issue", note: "hello", action: "create" },
        issue: {
          iid: 8,
          title: "Bug",
          description: "parent issue description",
          url: "https://gitlab.internal/Acme/API/-/issues/8",
        },
      },
    });
    expect(note.event).toMatchObject({ kind: "commented", surface: { body: "hello" }, entity: { type: "issue" } });

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

  it("returns an authenticated no-op for unsupported event kinds", () => {
    const result = normalizeGitlabWebhook({ ...base, eventHeader: "Push Hook", body: { object_kind: "push" } });
    expect(result.event).toBeNull();
  });

  it("fails closed on event/body mismatch and malformed reviewers", () => {
    expect(() =>
      normalizeGitlabWebhook({ ...base, eventHeader: "Issue Hook", body: { object_kind: "merge_request" } }),
    ).toThrow("does not match");
    expect(() =>
      normalizeGitlabWebhook({
        ...base,
        eventHeader: "Merge Request Hook",
        body: {
          object_kind: "merge_request",
          project: project(),
          user: { username: "alice" },
          reviewers: null,
          object_attributes: { iid: 1 },
        },
      }),
    ).toThrow("reviewers must be an array");
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
