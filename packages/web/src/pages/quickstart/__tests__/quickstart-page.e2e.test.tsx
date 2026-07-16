// @vitest-environment happy-dom

import type { CreateTaskChat, LandingCampaignStartRequest, LandingCampaignStartResponse } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CampaignIntent, readCampaignIntent, writeCampaignIntent } from "../intent.js";
import { QuickstartPage } from "../quickstart-page.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const navigateMock = vi.hoisted(() => vi.fn());
const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1" as string | null,
    refreshMe: vi.fn(async () => undefined),
    meLoaded: true,
    onboardingStep: "connect" as "connect" | "create_agent" | "completed" | null,
    onboardingDismissedAt: null as string | null,
    onboardingCompletedAt: null as string | null,
    currentOrgHasPersonalAgent: false,
  },
}));
const growthLandingMock = vi.hoisted(() => ({
  value: { enabled: true, settled: true },
}));
const landingCampaignMock = vi.hoisted(() => ({
  startLandingCampaign: vi.fn(
    async (_args: LandingCampaignStartRequest): Promise<LandingCampaignStartResponse> => ({
      chatId: "chat-1",
      agentUuid: "agent-1",
      campaign: "production-scan",
      repoCanonicalKey: "github.com/acme/backend",
    }),
  ),
}));
const agentsApiMock = vi.hoisted(() => ({
  getNewChatDefaultCandidates: vi.fn(
    async (): Promise<{ agent: { uuid: string; displayName: string } | null }> => ({
      agent: { uuid: "agent-dev-1", displayName: "Dev Agent" },
    }),
  ),
}));
const meChatsApiMock = vi.hoisted(() => ({
  createMeTaskChat: vi.fn(async (_body: CreateTaskChat): Promise<{ chatId: string }> => ({ chatId: "chat-fix-1" })),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useNavigate: () => navigateMock };
});
vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../../hooks/use-server-channel.js", () => ({
  useGrowthLandingPagesState: () => growthLandingMock.value,
  useGrowthLandingPagesEnabled: () => growthLandingMock.value.enabled,
}));
vi.mock("../../../api/landing-campaigns.js", () => landingCampaignMock);
vi.mock("../../../api/agents.js", () => agentsApiMock);
vi.mock("../../../api/me-chats.js", () => meChatsApiMock);
// The trial chat now renders the real workspace shell; stub it so this unit
// test stays focused on QuickstartPage's launcher/routing, not the whole
// three-pane workspace. WorkspaceBody reads the selected chat from `?c=`.
vi.mock("../../workspace/index.js", () => ({
  WorkspaceBody: () => <div data-testid="quickstart-trial-chat" />,
}));

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: createStorage() });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: window.sessionStorage });
  authMock.value = {
    organizationId: "org-1",
    refreshMe: vi.fn(async () => undefined),
    meLoaded: true,
    onboardingStep: "connect",
    onboardingDismissedAt: null,
    onboardingCompletedAt: null,
    currentOrgHasPersonalAgent: false,
  };
  growthLandingMock.value = { enabled: true, settled: true };
  landingCampaignMock.startLandingCampaign.mockResolvedValue({
    chatId: "chat-1",
    agentUuid: "agent-1",
    campaign: "production-scan",
    repoCanonicalKey: "github.com/acme/backend",
  });
  agentsApiMock.getNewChatDefaultCandidates.mockResolvedValue({
    agent: { uuid: "agent-dev-1", displayName: "Dev Agent" },
  });
  meChatsApiMock.createMeTaskChat.mockResolvedValue({ chatId: "chat-fix-1" });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function renderPage(initialEntries = ["/quickstart"]): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={initialEntries}>
        <QueryClientProvider client={queryClient}>
          <QuickstartPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

function seedIntent(campaign: CampaignIntent["campaign"] = "production-scan", attributed = false): void {
  writeCampaignIntent({
    campaign,
    owner: "acme",
    repo: "backend",
    repoSlug: "acme/backend",
    url: "https://github.com/acme/backend",
    ...(attributed ? { attribution: { attemptId: "018f5f17-7bb0-7d6d-8d86-91c901d5f2bf", variant: "control" } } : {}),
  });
}

describe("QuickstartPage — landing campaign trial flow", () => {
  it("starts the landing campaign trial from stored intent, refreshes /me, clears intent, and navigates", async () => {
    seedIntent("production-scan", true);
    await renderPage();

    expect(landingCampaignMock.startLandingCampaign).toHaveBeenCalledTimes(1);
    expect(landingCampaignMock.startLandingCampaign).toHaveBeenCalledWith({
      organizationId: "org-1",
      campaign: "production-scan",
      repoUrl: "https://github.com/acme/backend",
      attribution: { attemptId: "018f5f17-7bb0-7d6d-8d86-91c901d5f2bf", variant: "control" },
    });
    expect(authMock.value.refreshMe).toHaveBeenCalled();
    expect(readCampaignIntent()).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith("/quickstart?c=chat-1", { replace: true });
  });

  it("renders the workspace shell for an existing trial chat and does not restart the trial", async () => {
    seedIntent("production-scan");
    const container = await renderPage(["/quickstart?c=chat-1"]);

    expect(container.querySelector('[data-testid="quickstart-trial-chat"]')).not.toBeNull();
    expect(landingCampaignMock.startLandingCampaign).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("shows the workspace (no dead-end) for an unsupported campaign handoff", async () => {
    seedIntent("production-scan");
    const container = await renderPage([
      "/quickstart?campaign=agent-readiness&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend",
    ]);

    expect(container.querySelector('[data-testid="quickstart-trial-chat"]')).not.toBeNull();
    expect(landingCampaignMock.startLandingCampaign).not.toHaveBeenCalled();
    expect(readCampaignIntent()).toBeNull();
  });

  it("canonicalizes a legacy ?chat= trial link to ?c= and starts nothing", async () => {
    await renderPage(["/quickstart?chat=chat-legacy"]);

    expect(navigateMock).toHaveBeenCalledWith("/quickstart?c=chat-legacy", { replace: true });
    expect(landingCampaignMock.startLandingCampaign).not.toHaveBeenCalled();
  });

  it("canonicalizes a legacy ?chat= link even with a stored intent, without starting a new trial", async () => {
    // A leftover valid intent in the same tab must NOT hijack a legacy
    // selected-chat link into launching a fresh trial before the redirect.
    seedIntent("production-scan");
    await renderPage(["/quickstart?chat=chat-legacy"]);

    expect(navigateMock).toHaveBeenCalledWith("/quickstart?c=chat-legacy", { replace: true });
    expect(landingCampaignMock.startLandingCampaign).not.toHaveBeenCalled();
  });

  it("does not start anything when the feature flag is disabled", async () => {
    growthLandingMock.value = { enabled: false, settled: true };
    seedIntent("production-scan");
    await renderPage();
    await flush();

    expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
    expect(landingCampaignMock.startLandingCampaign).not.toHaveBeenCalled();
  });

  it("holds a neutral screen while the feature flag is still loading", async () => {
    growthLandingMock.value = { enabled: false, settled: false };
    seedIntent("production-scan");
    const container = await renderPage();
    await flush();

    expect(container.textContent).toContain("Loading");
    expect(navigateMock).not.toHaveBeenCalled();
    expect(landingCampaignMock.startLandingCampaign).not.toHaveBeenCalled();
  });

  it("renders the workspace and starts nothing when there is no campaign intent", async () => {
    const container = await renderPage();

    expect(container.querySelector('[data-testid="quickstart-trial-chat"]')).not.toBeNull();
    expect(landingCampaignMock.startLandingCampaign).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("start failure surfaces an error and retry drives exactly one more start call", async () => {
    seedIntent("production-scan");
    landingCampaignMock.startLandingCampaign
      .mockRejectedValueOnce(new Error("server unavailable"))
      .mockResolvedValueOnce({
        chatId: "chat-2",
        agentUuid: "agent-1",
        campaign: "production-scan",
        repoCanonicalKey: "github.com/acme/backend",
      });
    const container = await renderPage();

    expect(landingCampaignMock.startLandingCampaign).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("server unavailable");
    expect(navigateMock).not.toHaveBeenCalled();

    const retryBtn = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Try again"),
    );
    if (!retryBtn) throw new Error("expected a Try again button");
    await act(async () => {
      retryBtn.click();
    });
    await flush();

    expect(landingCampaignMock.startLandingCampaign).toHaveBeenCalledTimes(2);
    expect(navigateMock).toHaveBeenCalledWith("/quickstart?c=chat-2", { replace: true });
  });
});

describe("QuickstartPage — production-scan fix handoff (action=fix)", () => {
  it("un-onboarded user: stores the handoff, routes to /onboarding, never starts a trial", async () => {
    authMock.value = { ...authMock.value, onboardingStep: "connect", currentOrgHasPersonalAgent: false };
    await renderPage([
      "/quickstart?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend&action=fix&report=acme-backend-20260101-abcdef",
    ]);

    expect(landingCampaignMock.startLandingCampaign).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/onboarding", { replace: true });
    expect(window.sessionStorage.getItem("onboarding:campaignActionHandoff")).toBe(
      JSON.stringify({
        campaign: "production-scan",
        repoUrl: "https://github.com/acme/backend",
        reportKey: "acme-backend-20260101-abcdef",
        repoSlug: "acme/backend",
      }),
    );
  });

  it("onboarded user: opens a direct fix task chat, clears the handoff, never starts a trial", async () => {
    authMock.value = {
      ...authMock.value,
      onboardingStep: "completed",
      currentOrgHasPersonalAgent: true,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    };
    await renderPage([
      "/quickstart?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend&action=fix&report=acme-backend-20260101-abcdef",
    ]);

    expect(landingCampaignMock.startLandingCampaign).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalledWith("/onboarding", { replace: true });
    expect(agentsApiMock.getNewChatDefaultCandidates).toHaveBeenCalledTimes(1);
    expect(meChatsApiMock.createMeTaskChat).toHaveBeenCalledTimes(1);
    const body = meChatsApiMock.createMeTaskChat.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      mode: "task",
      topic: "Fix production scan blockers",
      initialRecipientAgentIds: ["agent-dev-1"],
      // The key new hop: the direct path carries the repo slug so the server
      // keys this launcher for cross-path dedup.
      campaignAction: { campaign: "production-scan", repoSlug: "acme/backend" },
    });
    expect(body?.initialMessage).toMatchObject({ format: "text", source: "web" });
    expect(body?.initialMessage.content).toContain(
      "Machine-readable findings: https://report.first-tree.ai/acme-backend-20260101-abcdef.json",
    );
    // Direct path uses the greeting-free bootstrap: the agent isn't being onboarded.
    expect(body?.initialMessage.content).not.toContain("welcome aboard");
    expect(navigateMock).toHaveBeenCalledWith("/?c=chat-fix-1", { replace: true });
    expect(window.sessionStorage.getItem("onboarding:campaignActionHandoff")).toBeNull();
  });

  it("waits for /me: with meLoaded=false a fix link routes nowhere and calls nothing", async () => {
    authMock.value = {
      ...authMock.value,
      meLoaded: false,
      onboardingStep: "completed",
      currentOrgHasPersonalAgent: true,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    };
    await renderPage([
      "/quickstart?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend&action=fix&report=acme-backend-20260101-abcdef",
    ]);

    expect(landingCampaignMock.startLandingCampaign).not.toHaveBeenCalled();
    expect(agentsApiMock.getNewChatDefaultCandidates).not.toHaveBeenCalled();
    expect(meChatsApiMock.createMeTaskChat).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("finish-later member (dismissed, no completion stamp) resumes onboarding, never direct chat", async () => {
    authMock.value = {
      ...authMock.value,
      onboardingStep: "completed",
      currentOrgHasPersonalAgent: true,
      onboardingDismissedAt: "2026-01-01T00:00:00.000Z",
      onboardingCompletedAt: null,
    };
    await renderPage([
      "/quickstart?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend&action=fix&report=acme-backend-20260101-abcdef",
    ]);

    expect(agentsApiMock.getNewChatDefaultCandidates).not.toHaveBeenCalled();
    expect(meChatsApiMock.createMeTaskChat).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/onboarding", { replace: true });
    expect(window.sessionStorage.getItem("onboarding:campaignActionHandoff")).toBe(
      JSON.stringify({
        campaign: "production-scan",
        repoUrl: "https://github.com/acme/backend",
        reportKey: "acme-backend-20260101-abcdef",
        repoSlug: "acme/backend",
      }),
    );
  });

  it("a stale trial intent cannot hijack a fix link into a trial", async () => {
    seedIntent("production-scan");
    authMock.value = {
      ...authMock.value,
      onboardingStep: "completed",
      currentOrgHasPersonalAgent: true,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    };
    await renderPage([
      "/quickstart?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend&action=fix&report=acme-backend-20260101-abcdef",
    ]);

    expect(landingCampaignMock.startLandingCampaign).not.toHaveBeenCalled();
    expect(meChatsApiMock.createMeTaskChat).toHaveBeenCalledTimes(1);
  });

  it("direct fix chat failure surfaces an error with retry and keeps the handoff", async () => {
    authMock.value = {
      ...authMock.value,
      onboardingStep: "completed",
      currentOrgHasPersonalAgent: true,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    };
    meChatsApiMock.createMeTaskChat.mockRejectedValueOnce(new Error("server unavailable"));
    const container = await renderPage([
      "/quickstart?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend&action=fix&report=acme-backend-20260101-abcdef",
    ]);

    expect(container.textContent).toContain("server unavailable");
    expect(navigateMock).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("onboarding:campaignActionHandoff")).toBe(
      JSON.stringify({
        campaign: "production-scan",
        repoUrl: "https://github.com/acme/backend",
        reportKey: "acme-backend-20260101-abcdef",
        repoSlug: "acme/backend",
      }),
    );
    const retryBtn = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Try again"),
    );
    expect(retryBtn).toBeTruthy();
  });

  it("onboarded user with no connectable agent: shows an error with retry, keeps the handoff", async () => {
    authMock.value = {
      ...authMock.value,
      onboardingStep: "completed",
      currentOrgHasPersonalAgent: true,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    };
    agentsApiMock.getNewChatDefaultCandidates.mockResolvedValueOnce({ agent: null });
    const container = await renderPage([
      "/quickstart?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend&action=fix&report=acme-backend-20260101-abcdef",
    ]);

    expect(meChatsApiMock.createMeTaskChat).not.toHaveBeenCalled();
    expect(container.textContent).toContain("No connected agent yet");
    expect(window.sessionStorage.getItem("onboarding:campaignActionHandoff")).toBe(
      JSON.stringify({
        campaign: "production-scan",
        repoUrl: "https://github.com/acme/backend",
        reportKey: "acme-backend-20260101-abcdef",
        repoSlug: "acme/backend",
      }),
    );
    const retryBtn = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Try again"),
    );
    expect(retryBtn).toBeTruthy();
  });

  it("plain campaign handoff (no action) still calls startLandingCampaign — regression guard", async () => {
    await renderPage(["/quickstart?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend"]);

    expect(landingCampaignMock.startLandingCampaign).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem("onboarding:campaignActionHandoff")).toBeNull();
  });

  it("action=fix with an invalid report stores reportKey: null and still routes", async () => {
    authMock.value = { ...authMock.value, onboardingStep: "connect", currentOrgHasPersonalAgent: false };
    await renderPage([
      "/quickstart?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend&action=fix&report=..%2F..%2Fetc%2Fpasswd",
    ]);

    expect(landingCampaignMock.startLandingCampaign).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/onboarding", { replace: true });
    expect(window.sessionStorage.getItem("onboarding:campaignActionHandoff")).toBe(
      JSON.stringify({
        campaign: "production-scan",
        repoUrl: "https://github.com/acme/backend",
        reportKey: null,
        repoSlug: "acme/backend",
      }),
    );
  });
});
