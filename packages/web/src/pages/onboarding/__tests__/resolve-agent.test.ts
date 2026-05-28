import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  listManagedAgents: vi.fn(),
}));
const flagsMock = vi.hoisted(() => ({
  readOnboardingAgentUuid: vi.fn(),
}));

const human = { uuid: "019e-human", displayName: "Ada", type: "human" };
const older = { uuid: "019e-agent-a", displayName: "Older", type: "agent" };
const newer = { uuid: "019e-agent-z", displayName: "Newer", type: "agent" };

function setupMocks(): void {
  vi.doMock("../../../api/agents.js", () => apiMock);
  vi.doMock("../../../utils/onboarding-flags.js", () => flagsMock);
}

describe("resolveOnboardingAgent", () => {
  beforeEach(() => {
    vi.resetModules();
    apiMock.listManagedAgents.mockReset();
    flagsMock.readOnboardingAgentUuid.mockReset();
  });

  afterEach(() => {
    vi.doUnmock("../../../api/agents.js");
    vi.doUnmock("../../../utils/onboarding-flags.js");
    vi.resetModules();
  });

  it("prefers the stashed non-human agent from this session", async () => {
    setupMocks();
    flagsMock.readOnboardingAgentUuid.mockReturnValue("019e-agent-a");
    apiMock.listManagedAgents.mockResolvedValue([human, newer, older]);

    const { resolveOnboardingAgent } = await import("../resolve-agent.js");

    await expect(resolveOnboardingAgent()).resolves.toBe(older);
  });

  it("falls back to the newest managed non-human agent", async () => {
    setupMocks();
    flagsMock.readOnboardingAgentUuid.mockReturnValue("missing-agent");
    apiMock.listManagedAgents.mockResolvedValue([older, human, newer]);

    const { resolveOnboardingAgent } = await import("../resolve-agent.js");

    await expect(resolveOnboardingAgent()).resolves.toBe(newer);
  });

  it("throws when no managed non-human agents exist", async () => {
    setupMocks();
    flagsMock.readOnboardingAgentUuid.mockReturnValue(null);
    apiMock.listManagedAgents.mockResolvedValue([human]);

    const { resolveOnboardingAgent } = await import("../resolve-agent.js");

    await expect(resolveOnboardingAgent()).rejects.toThrow("No agent found");
  });
});
