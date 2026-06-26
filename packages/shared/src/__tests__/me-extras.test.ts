import { describe, expect, it } from "vitest";
import { kickoffKindSchema, onboardingEventNameSchema } from "../schemas/me-extras.js";

describe("kickoffKindSchema", () => {
  it("accepts production_scan as a distinct onboarding kickoff intent", () => {
    expect(kickoffKindSchema.safeParse("production_scan").success).toBe(true);
  });
});

describe("onboardingEventNameSchema", () => {
  it("accepts production-scan growth funnel events", () => {
    expect(onboardingEventNameSchema.safeParse("production_scan_setup_prompt_copied").success).toBe(true);
    expect(onboardingEventNameSchema.safeParse("production_scan_kickoff_started").success).toBe(true);
  });
});
