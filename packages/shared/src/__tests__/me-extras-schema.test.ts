import { describe, expect, it } from "vitest";
import { kickoffOnboardingSchema, treeSetupKickoffSchema } from "../schemas/me-extras.js";

describe("kickoffOnboardingSchema", () => {
  it("accepts a natural onboarding kickoff without an internal kind discriminator", () => {
    const parsed = kickoffOnboardingSchema.parse({
      organizationId: "org-1",
      agentUuid: "agent-1",
      bootstrap: "First Tree is getting the agent up to speed.",
      topic: "Get started with First Tree",
      complete: false,
    });

    expect(parsed).not.toHaveProperty("kind");
    expect(parsed.topic).toBe("Get started with First Tree");
    expect(parsed.complete).toBe(false);
  });

  it("accepts the stamp variants alongside the older complete boolean", () => {
    for (const stamp of ["completed", "invitee_skip", "none"] as const) {
      const parsed = kickoffOnboardingSchema.parse({
        agentUuid: "agent-1",
        bootstrap: "First Tree is getting the agent up to speed.",
        stamp,
      });
      expect(parsed.stamp).toBe(stamp);
    }
  });

  it("rejects an unknown stamp value", () => {
    const parsed = kickoffOnboardingSchema.safeParse({
      agentUuid: "agent-1",
      bootstrap: "First Tree is getting the agent up to speed.",
      stamp: "dismissed",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects the retired kickoff kind field", () => {
    const parsed = kickoffOnboardingSchema.safeParse({
      agentUuid: "agent-1",
      bootstrap: "First Tree is getting the agent up to speed.",
      kind: "work",
    });

    expect(parsed.success).toBe(false);
  });

  it("still rejects unknown extra fields", () => {
    const parsed = kickoffOnboardingSchema.safeParse({
      agentUuid: "agent-1",
      bootstrap: "First Tree is getting the agent up to speed.",
      unexpected: "value",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts one campaign action contract and rejects it alongside the legacy field", () => {
    const base = { agentUuid: "agent-1", bootstrap: "Fix the findings." };
    expect(
      kickoffOnboardingSchema.parse({
        ...base,
        campaignAction: { campaign: "production-scan", repoSlug: "acme/api" },
      }).campaignAction,
    ).toEqual({ campaign: "production-scan", repoSlug: "acme/api" });
    expect(
      kickoffOnboardingSchema.safeParse({
        ...base,
        campaignAction: { campaign: "production-scan", repoSlug: "acme/api" },
        scanFixRepoSlug: "acme/api",
      }).success,
    ).toBe(false);
  });
});

describe("treeSetupKickoffSchema", () => {
  it("accepts only the selected agent for the dedicated setup intent", () => {
    const parsed = treeSetupKickoffSchema.parse({ agentUuid: "agent-1" });

    expect(parsed).not.toHaveProperty("kind");
    expect(parsed).not.toHaveProperty("organizationId");
    expect(parsed).not.toHaveProperty("complete");
    expect(parsed).toEqual({ agentUuid: "agent-1" });
  });

  it("rejects org scope and onboarding completion controls in the body", () => {
    expect(
      treeSetupKickoffSchema.safeParse({
        organizationId: "org-1",
        agentUuid: "agent-1",
      }).success,
    ).toBe(false);
    expect(
      treeSetupKickoffSchema.safeParse({
        agentUuid: "agent-1",
        complete: true,
      }).success,
    ).toBe(false);
    expect(
      treeSetupKickoffSchema.safeParse({
        agentUuid: "agent-1",
        bootstrap: "Client-controlled setup semantics.",
      }).success,
    ).toBe(false);
  });
});
