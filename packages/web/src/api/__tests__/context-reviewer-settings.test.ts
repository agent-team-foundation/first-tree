import { contextReviewerCandidatesOutputSchema, orgContextTreeFeaturesOutputSchema } from "@first-tree/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../client.js";
import {
  getContextReviewerCandidates,
  putContextReviewerAssignment,
  putContextReviewerEnablement,
} from "../context-reviewer-settings.js";

vi.mock("../client.js", () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
  },
}));

const candidates = contextReviewerCandidatesOutputSchema.parse({
  items: [
    {
      uuid: "agent-1",
      name: "reviewer",
      displayName: "Context Reviewer",
      visibility: "organization",
      runtime: { health: "degraded", blockers: [] },
    },
  ],
  blockers: [],
});

const features = orgContextTreeFeaturesOutputSchema.parse({
  contextReviewer: {
    enabled: false,
    agentUuid: "agent-1",
    reviewerAgent: {
      uuid: "agent-1",
      name: "reviewer",
      displayName: "Context Reviewer",
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockResolvedValue(candidates);
  vi.mocked(api.put).mockResolvedValue(features);
});

describe("Context Reviewer owner API", () => {
  it("encodes the Team and parses eligible candidates", async () => {
    await expect(getContextReviewerCandidates("org/one")).resolves.toEqual(candidates);
    expect(api.get).toHaveBeenCalledWith("/orgs/org%2Fone/context-reviewer/candidates");
  });

  it("keeps assignment and enablement as separate writes", async () => {
    await expect(putContextReviewerAssignment("org/one", "agent-1")).resolves.toEqual(features);
    await expect(putContextReviewerEnablement("org/one", true)).resolves.toEqual(features);

    expect(api.put).toHaveBeenNthCalledWith(1, "/orgs/org%2Fone/context-reviewer/assignment", {
      agentUuid: "agent-1",
    });
    expect(api.put).toHaveBeenNthCalledWith(2, "/orgs/org%2Fone/context-reviewer/enablement", {
      enabled: true,
    });
  });

  it("rejects malformed Server responses", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ items: [{ uuid: "private-agent" }], blockers: [] });
    await expect(getContextReviewerCandidates("org-1")).rejects.toThrow();
  });
});
