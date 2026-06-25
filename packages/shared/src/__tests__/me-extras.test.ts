import { describe, expect, it } from "vitest";
import { kickoffKindSchema, onboardingEventNameSchema } from "../schemas/me-extras.js";

describe("kickoffKindSchema", () => {
  it("accepts repo_work as a distinct onboarding kickoff intent", () => {
    expect(kickoffKindSchema.safeParse("repo_work").success).toBe(true);
  });
});

describe("onboardingEventNameSchema", () => {
  it("accepts repo-work growth funnel events", () => {
    expect(onboardingEventNameSchema.safeParse("repo_work_landing_submitted").success).toBe(true);
    expect(onboardingEventNameSchema.safeParse("repo_work_setup_prompt_copied").success).toBe(true);
    expect(onboardingEventNameSchema.safeParse("repo_work_kickoff_started").success).toBe(true);
  });
});
