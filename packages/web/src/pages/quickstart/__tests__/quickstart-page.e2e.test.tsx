// @vitest-environment happy-dom

import type { LandingCampaignStartRequest, LandingCampaignStartResponse } from "@first-tree/shared";
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
  };
  growthLandingMock.value = { enabled: true, settled: true };
  landingCampaignMock.startLandingCampaign.mockResolvedValue({
    chatId: "chat-1",
    agentUuid: "agent-1",
    campaign: "production-scan",
    repoCanonicalKey: "github.com/acme/backend",
  });
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

function seedIntent(campaign: CampaignIntent["campaign"] = "production-scan"): void {
  writeCampaignIntent({
    campaign,
    owner: "acme",
    repo: "backend",
    repoSlug: "acme/backend",
    url: "https://github.com/acme/backend",
  });
}

describe("QuickstartPage — landing campaign trial flow", () => {
  it("starts the landing campaign trial from stored intent, refreshes /me, clears intent, and navigates", async () => {
    seedIntent("production-scan");
    await renderPage();

    expect(landingCampaignMock.startLandingCampaign).toHaveBeenCalledTimes(1);
    expect(landingCampaignMock.startLandingCampaign).toHaveBeenCalledWith({
      organizationId: "org-1",
      campaign: "production-scan",
      repoUrl: "https://github.com/acme/backend",
    });
    expect(authMock.value.refreshMe).toHaveBeenCalled();
    expect(readCampaignIntent()).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith("/?c=chat-1");
  });

  it("ignores unsupported campaign handoffs", async () => {
    seedIntent("production-scan");
    const container = await renderPage([
      "/quickstart?campaign=agent-readiness&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend",
    ]);

    expect(container.textContent).toContain("Start from a First Tree scan");
    expect(landingCampaignMock.startLandingCampaign).not.toHaveBeenCalled();
    expect(readCampaignIntent()).toBeNull();
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

  it("missing campaign intent renders a pointer and starts nothing", async () => {
    const container = await renderPage();

    expect(container.textContent).toContain("Start from a First Tree scan");
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
    expect(navigateMock).toHaveBeenCalledWith("/?c=chat-2");
  });
});
