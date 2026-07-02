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

  it("accepts and drops the retired kickoff kind field for rolling-deploy compatibility", () => {
    const parsed = kickoffOnboardingSchema.parse({
      agentUuid: "agent-1",
      bootstrap: "First Tree is getting the agent up to speed.",
      kind: "work",
    });

    expect(parsed).not.toHaveProperty("kind");
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
      organizationId: "org-1",
      agentUuid: "agent-1",
      bootstrap: "Set up shared context.",
      topic: "Set up shared context",
      complete: false,
    });

    expect(parsed).not.toHaveProperty("kind");
    expect(parsed.topic).toBe("Set up shared context");
  });
});
