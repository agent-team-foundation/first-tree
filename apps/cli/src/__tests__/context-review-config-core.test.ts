import { describe, expect, it, vi } from "vitest";
import { normalizeContextReviewConfig, readContextReviewConfig } from "../core/context-review-config.js";

describe("Context Review configuration", () => {
  it("derives assignment from the selected local agent", () => {
    expect(
      normalizeContextReviewConfig(
        {
          enabled: true,
          agentUuid: "reviewer-1",
          workflow: "agent_review",
          governance: "autonomous",
          mergeMethod: "rebase",
          reviewerAgent: null,
        },
        "reviewer-1",
      ),
    ).toEqual({
      enabled: true,
      assigned: true,
      agentUuid: "reviewer-1",
      workflow: "agent_review",
      governance: "autonomous",
      mergeMethod: "rebase",
    });
  });

  it("keeps legacy defaults compatible with stored two-field configurations", () => {
    expect(normalizeContextReviewConfig({ enabled: false, agentUuid: null }, "reviewer-1")).toEqual({
      enabled: false,
      assigned: false,
      agentUuid: null,
      workflow: "legacy_app",
      governance: "human",
      mergeMethod: "squash",
    });
  });

  it("rejects malformed server output", () => {
    expect(() =>
      normalizeContextReviewConfig(
        {
          enabled: true,
          agentUuid: "reviewer-1",
          workflow: "agent_review",
          governance: "unbounded",
          mergeMethod: "squash",
        },
        "reviewer-1",
      ),
    ).toThrow(/invalid Context Review configuration/);
  });

  it("reads once through the SDK", async () => {
    const getAgentContextReviewConfig = vi.fn(async () => ({
      enabled: true,
      agentUuid: "reviewer-2",
      workflow: "agent_review",
      governance: "human",
      mergeMethod: "merge",
    }));

    await expect(
      readContextReviewConfig({ agentId: "reviewer-1", getAgentContextReviewConfig }),
    ).resolves.toMatchObject({ enabled: true, assigned: false, agentUuid: "reviewer-2" });
    expect(getAgentContextReviewConfig).toHaveBeenCalledTimes(1);
  });
});
