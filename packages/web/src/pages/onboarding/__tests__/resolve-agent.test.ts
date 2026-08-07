// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedAgent } from "../../../api/agents.js";
import { writeOnboardingAgentUuid } from "../../../utils/onboarding-flags.js";
import { resolveOnboardingAgent } from "../resolve-agent.js";

const agentApiMocks = vi.hoisted(() => ({
  listManagedAgents: vi.fn(),
}));

vi.mock("../../../api/agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/agents.js")>()),
  listManagedAgents: agentApiMocks.listManagedAgents,
}));

function managedAgent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    uuid: overrides.uuid ?? "01920000-0000-7000-8000-000000000001",
    name: overrides.name ?? "nova",
    displayName: overrides.displayName ?? "Nova",
    type: overrides.type ?? "agent",
    organizationId: overrides.organizationId ?? "org-1",
    inboxId: overrides.inboxId ?? "inbox-1",
    visibility: overrides.visibility ?? "organization",
    runtimeProvider: overrides.runtimeProvider ?? "codex",
    clientId: overrides.clientId ?? "client-1",
    status: overrides.status ?? "active",
    avatarImageUrl: overrides.avatarImageUrl ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe("resolveOnboardingAgent", () => {
  it("restores the exact agent created earlier instead of trusting list order or the flow's default name", async () => {
    const resumed = managedAgent({
      uuid: "01920000-0000-7000-8000-000000000001",
      displayName: "Resumed Agent",
    });
    const newer = managedAgent({
      uuid: "01930000-0000-7000-8000-000000000001",
      displayName: "Newer Unrelated Agent",
    });
    agentApiMocks.listManagedAgents.mockResolvedValue([newer, resumed]);
    writeOnboardingAgentUuid(resumed.uuid);

    await expect(resolveOnboardingAgent("org-1")).resolves.toEqual(resumed);
  });

  it("ignores a stashed agent from another team and stays inside the selected organization", async () => {
    const otherTeam = managedAgent({
      uuid: "01940000-0000-7000-8000-000000000001",
      organizationId: "org-2",
      displayName: "Other Team Agent",
    });
    const selectedTeam = managedAgent({
      uuid: "01930000-0000-7000-8000-000000000001",
      organizationId: "org-1",
      displayName: "Selected Team Agent",
    });
    agentApiMocks.listManagedAgents.mockResolvedValue([otherTeam, selectedTeam]);
    writeOnboardingAgentUuid(otherTeam.uuid);

    await expect(resolveOnboardingAgent("org-1")).resolves.toEqual(selectedTeam);
  });
});
