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
});

describe("treeSetupKickoffSchema", () => {
  it("accepts a dedicated tree setup kickoff without a kind discriminator", () => {
    const parsed = treeSetupKickoffSchema.parse({
      agentUuid: "agent-1",
      bootstrap: "Set up shared context.",
      topic: "Set up shared context",
    });

    expect(parsed).not.toHaveProperty("kind");
    expect(parsed).not.toHaveProperty("organizationId");
    expect(parsed).not.toHaveProperty("complete");
    expect(parsed.topic).toBe("Set up shared context");
  });

  it("rejects org scope and onboarding completion controls in the body", () => {
    expect(
      treeSetupKickoffSchema.safeParse({
        organizationId: "org-1",
        agentUuid: "agent-1",
        bootstrap: "Set up shared context.",
      }).success,
    ).toBe(false);
    expect(
      treeSetupKickoffSchema.safeParse({
        agentUuid: "agent-1",
        bootstrap: "Set up shared context.",
        complete: true,
      }).success,
    ).toBe(false);
  });
});
