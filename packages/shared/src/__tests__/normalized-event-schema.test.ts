import { describe, expect, it } from "vitest";
import { githubEventCardSchema, normalizedEventSchema } from "../schemas/normalized-event.js";
import { webhookSourceSchema } from "../schemas/webhook-source.js";

const sampleSource = {
  kind: "github-app-installation" as const,
  installationId: 12345,
  organizationId: "org-uuid",
};

const sampleEvent = {
  source: sampleSource,
  deliveryId: "delivery-1",
  rawEventType: "pull_request",
  rawAction: "opened",
  entity: {
    type: "pull_request" as const,
    repo: "owner/repo",
    key: "owner/repo#1",
    title: "Improve onboarding flow",
    url: "https://github.com/owner/repo/pull/1",
  },
  actor: {
    githubLogin: "alice",
    isBot: false,
  },
  kind: "opened" as const,
  involves: [
    { githubLogin: "bob", reason: "mentioned" as const },
    { githubLogin: "carol", reason: "review_requested" as const },
  ],
  surface: {
    title: "PR #1: Improve onboarding flow",
    body: "Hey @bob, please review",
    url: "https://github.com/owner/repo/pull/1",
  },
  relatedRefs: [{ type: "issue" as const, key: "owner/repo#42" }],
};

describe("webhookSourceSchema", () => {
  it("accepts a github-app-installation source", () => {
    expect(webhookSourceSchema.safeParse(sampleSource).success).toBe(true);
  });

  it("rejects non-integer installationId", () => {
    const res = webhookSourceSchema.safeParse({ ...sampleSource, installationId: 1.5 });
    expect(res.success).toBe(false);
  });

  it("rejects empty organizationId", () => {
    const res = webhookSourceSchema.safeParse({ ...sampleSource, organizationId: "" });
    expect(res.success).toBe(false);
  });

  it("rejects an unknown kind literal", () => {
    const res = webhookSourceSchema.safeParse({ ...sampleSource, kind: "github-org-secret" });
    expect(res.success).toBe(false);
  });
});

describe("normalizedEventSchema", () => {
  it("accepts a full pull_request.opened event", () => {
    expect(normalizedEventSchema.safeParse(sampleEvent).success).toBe(true);
  });

  it("accepts deliveryId=null and rawAction=null (synthetic events)", () => {
    const res = normalizedEventSchema.safeParse({
      ...sampleEvent,
      deliveryId: null,
      rawAction: null,
      kind: "synchronized" as const,
      involves: [],
    });
    expect(res.success).toBe(true);
  });

  it("accepts empty involves[] (subscribed-only event)", () => {
    const res = normalizedEventSchema.safeParse({ ...sampleEvent, involves: [] });
    expect(res.success).toBe(true);
  });

  it("rejects unknown involve reason", () => {
    const res = normalizedEventSchema.safeParse({
      ...sampleEvent,
      involves: [{ githubLogin: "bob", reason: "subscribed" }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects unknown entity.type", () => {
    const res = normalizedEventSchema.safeParse({
      ...sampleEvent,
      entity: { ...sampleEvent.entity, type: "release" },
    });
    expect(res.success).toBe(false);
  });

  it("rejects unknown normalized kind", () => {
    const res = normalizedEventSchema.safeParse({ ...sampleEvent, kind: "labeled" });
    expect(res.success).toBe(false);
  });

  it("rejects relatedRefs with non-issue type", () => {
    const res = normalizedEventSchema.safeParse({
      ...sampleEvent,
      relatedRefs: [{ type: "pull_request", key: "owner/repo#9" }],
    });
    expect(res.success).toBe(false);
  });
});

describe("githubEventCardSchema", () => {
  const baseCard = {
    type: "github_event" as const,
    reason: "subscribed" as const,
    event: "pull_request",
    action: "synchronize",
    kind: "synchronized" as const,
    repository: "owner/repo",
    sender: "alice",
    title: "PR #1: ...",
    body: "",
    url: "https://github.com/owner/repo/pull/1",
    entity: {
      type: "pull_request" as const,
      key: "owner/repo#1",
      url: "https://github.com/owner/repo/pull/1",
    },
  };

  it("accepts a subscribed reason card without mentionedUser", () => {
    expect(githubEventCardSchema.safeParse(baseCard).success).toBe(true);
  });

  it("accepts an involves-driven card carrying mentionedUser", () => {
    const res = githubEventCardSchema.safeParse({
      ...baseCard,
      reason: "mentioned" as const,
      mentionedUser: "bob",
    });
    expect(res.success).toBe(true);
  });

  it("accepts a null entity.url (missing canonical url)", () => {
    const res = githubEventCardSchema.safeParse({
      ...baseCard,
      entity: { ...baseCard.entity, url: null },
    });
    expect(res.success).toBe(true);
  });

  it("rejects unknown reason", () => {
    const res = githubEventCardSchema.safeParse({ ...baseCard, reason: "labelled" });
    expect(res.success).toBe(false);
  });

  it("rejects wrong type literal", () => {
    const res = githubEventCardSchema.safeParse({ ...baseCard, type: "github_mention" });
    expect(res.success).toBe(false);
  });
});
