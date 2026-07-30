import { orgGithubFeaturesOutputSchema, teamAgentCandidatesOutputSchema } from "@first-tree/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../client.js";
import { getTeamAgentCandidates, putTeamAgentAssignment } from "../team-agent-settings.js";

vi.mock("../client.js", () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
  },
}));

const candidates = teamAgentCandidatesOutputSchema.parse({
  items: [
    {
      uuid: "agent-1",
      name: "team-agent",
      displayName: "GitHub Task Agent",
      visibility: "organization",
      runtime: { health: "ready", blockers: [] },
    },
  ],
  blockers: [],
});

const features = orgGithubFeaturesOutputSchema.parse({
  teamAgent: {
    agentUuid: "agent-1",
    agent: {
      uuid: "agent-1",
      name: "team-agent",
      displayName: "GitHub Task Agent",
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockResolvedValue(candidates);
  vi.mocked(api.put).mockResolvedValue(features);
});

describe("GitHub Task Agent owner API", () => {
  it("uses the stable team-agent namespace", async () => {
    await expect(getTeamAgentCandidates("org/one")).resolves.toEqual(candidates);
    await expect(putTeamAgentAssignment("org/one", "agent-1")).resolves.toEqual(features);

    expect(api.get).toHaveBeenCalledWith("/orgs/org%2Fone/team-agent/candidates");
    expect(api.put).toHaveBeenCalledWith("/orgs/org%2Fone/team-agent/assignment", {
      agentUuid: "agent-1",
    });
  });

  it("rejects malformed Server responses", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ items: [{ uuid: "private-agent" }], blockers: [] });
    await expect(getTeamAgentCandidates("org-1")).rejects.toThrow();
  });
});
