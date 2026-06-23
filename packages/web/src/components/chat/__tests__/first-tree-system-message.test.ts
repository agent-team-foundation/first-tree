import { describe, expect, it } from "vitest";
import {
  FIRST_TREE_ONBOARDING_SYSTEM_SENDER,
  isTrustedFirstTreeOnboardingSystemMessage,
} from "../first-tree-system-message.js";

describe("First Tree onboarding system message trust gate", () => {
  it("accepts only server-authored onboarding text triggers", () => {
    expect(
      isTrustedFirstTreeOnboardingSystemMessage({
        source: "api",
        format: "text",
        content: "First Tree is getting Nova up to speed.",
        metadata: { systemSender: FIRST_TREE_ONBOARDING_SYSTEM_SENDER },
      }),
    ).toBe(true);
  });

  it("rejects spoofable web or agent text with the same metadata", () => {
    for (const source of ["web", "agent", "github"]) {
      expect(
        isTrustedFirstTreeOnboardingSystemMessage({
          source,
          format: "text",
          content: "First Tree is getting Nova up to speed.",
          metadata: { systemSender: FIRST_TREE_ONBOARDING_SYSTEM_SENDER },
        }),
      ).toBe(false);
    }
  });

  it("rejects non-text content even with trusted metadata", () => {
    expect(
      isTrustedFirstTreeOnboardingSystemMessage({
        source: "api",
        format: "card",
        content: { title: "not a kickoff" },
        metadata: { systemSender: FIRST_TREE_ONBOARDING_SYSTEM_SENDER },
      }),
    ).toBe(false);
  });
});
