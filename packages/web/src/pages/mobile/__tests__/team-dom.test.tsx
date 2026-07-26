// @vitest-environment happy-dom

import type { Agent, MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";

const authMock = vi.hoisted(() => {
  const memberships: MeMembership[] = [];
  const currentMembership: MeMembership | null = null;
  return {
    value: {
      isAuthenticated: true,
      meLoaded: true,
      user: { id: "user-self", username: "gandy", displayName: "Gandy", avatarUrl: null },
      memberships,
      currentMembership,
      organizationId: "org-1",
      memberId: "member-self",
      role: "admin",
      agentId: "human-agent-self",
      teamDisplayName: "Acme Research",
      orgHasOtherMembers: true,
      currentOrgHasUsableAgent: true,
      currentOrgHasPersonalAgent: true,
      docsEnabled: false,
      onboardingStep: "completed" as const,
      onboardingDismissedAt: null,
      onboardingCompletedAt: "2026-07-01T00:00:00.000Z",
      dismissOnboarding: vi.fn(async () => undefined),
      restoreOnboarding: vi.fn(async () => undefined),
      markOnboardingCompleted: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      adoptTokens: vi.fn(async () => undefined),
      selectOrganization: vi.fn(async () => undefined),
      switchingOrg: null,
      setSwitchingOrg: vi.fn(),
      refreshMe: vi.fn(async () => undefined),
      logout: vi.fn(),
    },
  };
});

const agentMocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listAllAgents: vi.fn(),
}));

const memberMocks = vi.hoisted(() => ({
  listMembers: vi.fn(),
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../api/agents.js", () => agentMocks);
vi.mock("../../../api/members.js", () => memberMocks);

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: "agent-1",
    name: "design-copilot",
    displayName: "Design Copilot",
    type: "assistant",
    visibility: "public",
    runtimeState: "idle",
    managerId: "member-self",
    avatarImageUrl: null,
    avatarColorToken: null,
    ...overrides,
  } as Agent;
}

function renderTeamPage(harness: DomHarness) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return import("../team.js").then(({ MobileTeamPage }) => {
    harness.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <MobileTeamPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
}

describe("MobileTeamPage", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
    agentMocks.listAgents.mockReset();
    agentMocks.listAllAgents.mockReset();
    memberMocks.listMembers.mockReset();
    agentMocks.listAllAgents.mockResolvedValue({ items: [agent()], nextCursor: null });
    memberMocks.listMembers.mockResolvedValue([
      {
        id: "member-self",
        userId: "user-self",
        organizationId: "org-1",
        agentId: "human-agent-self",
        role: "admin",
        createdAt: "2026-07-01T00:00:00.000Z",
        username: "gandy",
        displayName: "Gandy",
        avatarUrl: null,
        lastActiveAt: "2026-07-10T07:00:00.000Z",
      },
      {
        id: "member-teammate",
        userId: "user-teammate",
        organizationId: "org-1",
        agentId: "human-agent-teammate",
        role: "member",
        createdAt: "2026-07-01T00:00:00.000Z",
        username: "teammate",
        displayName: "Teammate",
        avatarUrl: null,
        lastActiveAt: null,
      },
    ]);
  });

  it("does not offer a self-chat action for the current human", async () => {
    await renderTeamPage(harness);
    await harness.waitFor(() => expect(harness.container.textContent).toContain("Gandy (you)"));

    expect(harness.container.querySelector('a[href="/m/work?c=draft&with=human-agent-self"]')).toBeNull();
    const teammateCard = harness.container.querySelector('a[href="/m/work?c=draft&with=human-agent-teammate"]');
    expect(teammateCard).not.toBeNull();
    expect(harness.container.querySelector('a[href="/m/work?c=draft&with=agent-1"]')).not.toBeNull();

    // Q1: the whole card is the tap target — the title lives inside the anchor,
    // and the separate chat-icon button is gone.
    expect(teammateCard?.textContent).toContain("Teammate");
    expect(harness.container.querySelector('button[aria-label^="Chat with"]')).toBeNull();
  });
});
