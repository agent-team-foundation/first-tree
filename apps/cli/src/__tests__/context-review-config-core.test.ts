import { describe, expect, it, vi } from "vitest";
import {
  normalizeContextReviewConfig,
  readContextReviewConfig,
  readMemberContextReviewConfig,
} from "../core/context-review-config.js";

describe("Context Review config", () => {
  it("normalizes one live binding and assignment tuple", () => {
    expect(
      normalizeContextReviewConfig(
        {
          repo: "https://github.com/acme/context-tree.git",
          branch: "main",
          contextReviewer: { enabled: true, agentUuid: "reviewer-1" },
        },
        "reviewer-1",
      ),
    ).toEqual({
      provider: "github",
      repo: "https://github.com/acme/context-tree.git",
      branch: "main",
      enabled: true,
      assigned: true,
      agentUuid: "reviewer-1",
    });
  });

  it("does not assign a disabled or different Reviewer", () => {
    expect(
      normalizeContextReviewConfig(
        { repo: null, branch: null, contextReviewer: { enabled: false, agentUuid: null } },
        "reviewer-1",
      ).assigned,
    ).toBe(false);
    expect(
      normalizeContextReviewConfig(
        {
          repo: "https://github.com/acme/context-tree.git",
          branch: "main",
          contextReviewer: { enabled: true, agentUuid: "reviewer-2" },
        },
        "reviewer-1",
      ).assigned,
    ).toBe(false);
  });

  it("fails closed for an invalid mixed response", () => {
    expect(() =>
      normalizeContextReviewConfig(
        { repo: "https://github.com/acme/context-tree.git", branch: 42, contextReviewer: { enabled: true } },
        "reviewer-1",
      ),
    ).toThrow(SyntaxError);
  });

  it("reads exactly one SDK response", async () => {
    const getAgentContextReviewConfig = vi.fn(async () => ({
      repo: "https://github.com/acme/context-tree.git",
      branch: "main",
      contextReviewer: { enabled: true, agentUuid: "reviewer-1" },
    }));
    await expect(
      readContextReviewConfig({ agentId: "reviewer-1", getAgentContextReviewConfig }),
    ).resolves.toMatchObject({ assigned: true });
    expect(getAgentContextReviewConfig).toHaveBeenCalledTimes(1);
  });

  it("combines the two existing member-readable settings without requiring a local Agent", async () => {
    const getMemberContextTreeSetting = vi.fn(async () => ({
      provider: "github",
      repo: "https://github.com/acme/context-tree.git",
      branch: "main",
    }));
    const getMemberContextTreeFeatures = vi.fn(async () => ({
      contextReviewer: {
        enabled: true,
        agentUuid: "reviewer-private",
        reviewerAgent: { uuid: "reviewer-private", name: "reviewer", displayName: "Reviewer" },
      },
    }));

    await expect(
      readMemberContextReviewConfig({ getMemberContextTreeSetting, getMemberContextTreeFeatures }, "org-1"),
    ).resolves.toEqual({
      provider: "github",
      repo: "https://github.com/acme/context-tree.git",
      branch: "main",
      enabled: true,
      assigned: true,
      agentUuid: "reviewer-private",
    });
    expect(getMemberContextTreeSetting).toHaveBeenCalledWith("org-1");
    expect(getMemberContextTreeFeatures).toHaveBeenCalledWith("org-1");
  });
});
