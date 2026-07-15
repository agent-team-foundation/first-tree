import { describe, expect, it } from "vitest";
import { githubEventCardSchema, normalizedScmEventSchema } from "../schemas/normalized-event.js";
import { scmIngressContextSchema, scmSourceSchema } from "../schemas/scm-source.js";

const sampleSource = {
  organizationId: "org-uuid",
  externalId: "installation:12345",
};

const sampleEvent = {
  provider: "github" as const,
  source: sampleSource,
  stableDeliveryId: "delivery-1",
  ingressAuthority: "verified_signature" as const,
  eventType: "pull_request",
  action: "opened",
  entity: {
    type: "pull_request" as const,
    projectKey: "owner/repo",
    key: "owner/repo#1",
    title: "Improve onboarding flow",
    url: "https://github.com/owner/repo/pull/1",
  },
  actor: {
    externalUsername: "alice",
    isBot: false,
  },
  kind: "opened" as const,
  targets: [
    { externalUsername: "bob", reason: "mentioned" as const },
    { externalUsername: "carol", reason: "review_requested" as const },
  ],
  surface: {
    title: "PR #1: Improve onboarding flow",
    body: "Hey @bob, please review",
    url: "https://github.com/owner/repo/pull/1",
  },
  relatedRefs: [{ type: "issue" as const, key: "owner/repo#42" }],
};

describe("scmSourceSchema", () => {
  it("accepts an opaque provider source", () => {
    expect(scmSourceSchema.safeParse(sampleSource).success).toBe(true);
  });

  it("rejects an empty externalId", () => {
    const res = scmSourceSchema.safeParse({ ...sampleSource, externalId: "" });
    expect(res.success).toBe(false);
  });

  it("rejects empty organizationId", () => {
    const res = scmSourceSchema.safeParse({ ...sampleSource, organizationId: "" });
    expect(res.success).toBe(false);
  });

  it("accepts only explicit ingress-derived authorities", () => {
    expect(scmIngressContextSchema.safeParse(sampleEvent).success).toBe(true);
    expect(scmIngressContextSchema.safeParse({ ...sampleEvent, ingressAuthority: "payload_claim" }).success).toBe(
      false,
    );
  });
});

describe("normalizedScmEventSchema", () => {
  it("accepts a full pull_request.opened event", () => {
    expect(normalizedScmEventSchema.safeParse(sampleEvent).success).toBe(true);
  });

  it("accepts stableDeliveryId=null and action=null", () => {
    const res = normalizedScmEventSchema.safeParse({
      ...sampleEvent,
      stableDeliveryId: null,
      action: null,
      kind: "synchronized" as const,
      targets: [],
    });
    expect(res.success).toBe(true);
  });

  it("accepts empty targets[] (subscribed-only event)", () => {
    const res = normalizedScmEventSchema.safeParse({ ...sampleEvent, targets: [] });
    expect(res.success).toBe(true);
  });

  it("rejects unknown involve reason", () => {
    const res = normalizedScmEventSchema.safeParse({
      ...sampleEvent,
      targets: [{ externalUsername: "bob", reason: "subscribed" }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects unknown entity.type", () => {
    const res = normalizedScmEventSchema.safeParse({
      ...sampleEvent,
      entity: { ...sampleEvent.entity, type: "release" },
    });
    expect(res.success).toBe(false);
  });

  it("rejects unknown normalized kind", () => {
    const res = normalizedScmEventSchema.safeParse({ ...sampleEvent, kind: "labeled" });
    expect(res.success).toBe(false);
  });

  it("rejects relatedRefs with non-issue type", () => {
    const res = normalizedScmEventSchema.safeParse({
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
