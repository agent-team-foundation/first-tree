import { describe, expect, it } from "vitest";
import { kickoffOnboardingSchema } from "../schemas/me-extras.js";

describe("kickoffOnboardingSchema", () => {
  it("accepts a value-first work kickoff distinct from intro and tree setup", () => {
    const parsed = kickoffOnboardingSchema.parse({
      organizationId: "org-1",
      agentUuid: "agent-1",
      bootstrap: "First Tree is getting the agent up to speed.",
      kind: "work",
      complete: false,
    });

    expect(parsed.kind).toBe("work");
    expect(parsed.complete).toBe(false);
  });
});
