// @vitest-environment happy-dom

import type { AgentVisibility } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../../../api/activity.js";
import type { StartOnboardingChatArgs } from "../../../api/onboarding-events.js";
import type { ComputerConnection } from "../../../features/agent-setup/use-computer-connection.js";
import { type CampaignIntent, readCampaignIntent, writeCampaignIntent, writeQuickstartAgentUuid } from "../intent.js";
import { QuickstartPage } from "../quickstart-page.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const navigateMock = vi.hoisted(() => vi.fn());
const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1" as string | null,
    user: { username: "gandy" },
    refreshMe: vi.fn(async () => undefined),
  },
}));

const computerMock = vi.hoisted(() => ({
  value: {
    connectedClient: null as ComputerConnection["connectedClient"],
    capabilitiesLoaded: false,
    okRuntimes: [] as string[],
    selectedRuntime: null as string | null,
    setSelectedRuntime: vi.fn(),
    cliCommand: "npx @first-tree/cli login ft_test" as string | null,
    tokenError: null as string | null,
    retry: vi.fn(),
  },
}));

type CreateAgentArgs = {
  displayName: string;
  clientId: string;
  runtimeProvider: string;
  visibility: AgentVisibility;
  organizationId: string | null;
};

const agentCreationMock = vi.hoisted(() => ({
  create: vi.fn(async (_args: CreateAgentArgs) => undefined),
  retry: vi.fn(async () => undefined),
  onOnline: undefined as ((uuid: string) => void) | undefined,
  value: {
    phase: "idle" as "idle" | "creating" | "online" | "timeout",
    error: null as string | null,
    createdUuid: null as string | null,
  },
}));

const onboardingMocks = vi.hoisted(() => ({
  postOnboardingStartChat: vi.fn(async (_args: StartOnboardingChatArgs) => ({ chatId: "chat-1" })),
  reportOnboardingEvent: vi.fn(async () => undefined),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useNavigate: () => navigateMock };
});
vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../../features/agent-setup/use-computer-connection.js", () => ({
  useComputerConnection: () => computerMock.value,
}));
vi.mock("../../../features/agent-setup/use-agent-creation.js", () => ({
  useAgentCreation: (opts?: { onOnline?: (uuid: string) => void }) => {
    agentCreationMock.onOnline = opts?.onOnline;
    return {
      phase: agentCreationMock.value.phase,
      error: agentCreationMock.value.error,
      createdUuid: agentCreationMock.value.createdUuid,
      create: agentCreationMock.create,
      retry: agentCreationMock.retry,
    };
  },
}));
vi.mock("../../../api/onboarding-events.js", () => onboardingMocks);

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

function hubClient(overrides: Partial<HubClient> = {}): HubClient {
  return {
    id: "client-1",
    userId: "user-1",
    status: "connected",
    authState: "ok",
    binName: "first-tree",
    sdkVersion: "0.1.0",
    serverCommandVersion: null,
    hostname: "gandys-macbook",
    os: "darwin",
    agentCount: 0,
    connectedAt: "2026-06-29T00:00:00.000Z",
    lastSeenAt: "2026-06-29T00:00:00.000Z",
    capabilities: {},
    ...overrides,
  };
}

let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: createStorage() });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: window.sessionStorage });
  computerMock.value = {
    connectedClient: null,
    capabilitiesLoaded: false,
    okRuntimes: [],
    selectedRuntime: null,
    setSelectedRuntime: vi.fn(),
    cliCommand: "npx @first-tree/cli login ft_test",
    tokenError: null,
    retry: vi.fn(),
  };
  agentCreationMock.value = { phase: "idle", error: null, createdUuid: null };
  agentCreationMock.onOnline = undefined;
  authMock.value = { organizationId: "org-1", user: { username: "gandy" }, refreshMe: vi.fn(async () => undefined) };
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function renderPage(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <QuickstartPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function seedIntent(campaign: CampaignIntent["campaign"] = "production-scan"): void {
  const intent: CampaignIntent = {
    campaign,
    owner: "acme",
    repo: "backend",
    repoSlug: "acme/backend",
    url: "https://github.com/acme/backend",
  };
  writeCampaignIntent(intent);
}

function connectedWith(...runtimes: string[]): void {
  computerMock.value = {
    ...computerMock.value,
    connectedClient: hubClient(),
    capabilitiesLoaded: true,
    okRuntimes: runtimes,
    selectedRuntime: runtimes[0] ?? null,
  };
}

async function fireOnline(uuid = "agent-1"): Promise<void> {
  await act(async () => {
    agentCreationMock.onOnline?.(uuid);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("QuickstartPage — full flow (e2e)", () => {
  it("waits on the connect step before the computer is up, creating nothing", async () => {
    seedIntent();
    const container = await renderPage();
    expect(container.textContent).toContain("acme/backend");
    expect(container.textContent).toContain("npx @first-tree/cli login ft_test");
    expect(agentCreationMock.create).not.toHaveBeenCalled();
  });

  it("auto-creates a private Cedar agent on the preferred runtime once the computer is ready", async () => {
    seedIntent();
    connectedWith("claude-code");
    await renderPage();
    expect(agentCreationMock.create).toHaveBeenCalledWith({
      displayName: "Cedar",
      clientId: "client-1",
      runtimeProvider: "claude-code",
      visibility: "private",
      organizationId: "org-1",
    });
  });

  it("production-scan: starts a work kickoff with the campaign segment + clean bootstrap + complete:false, then navigates", async () => {
    seedIntent("production-scan");
    connectedWith("claude-code");
    await renderPage();
    await fireOnline("agent-1");

    expect(onboardingMocks.postOnboardingStartChat).toHaveBeenCalledTimes(1);
    const arg = onboardingMocks.postOnboardingStartChat.mock.calls[0]?.[0];
    if (!arg) throw new Error("expected a start-chat call");
    expect(arg).toMatchObject({
      organizationId: "org-1",
      agentUuid: "agent-1",
      kind: "work",
      campaign: "production-scan",
      complete: false,
    });
    expect(arg.bootstrap).toContain("Cedar");
    expect(arg.bootstrap).toContain("github.com/acme/backend");
    // dual-reader: the bootstrap renders verbatim to the user, so no jargon.
    expect(arg.bootstrap.toLowerCase()).not.toContain("skill");
    expect(navigateMock).toHaveBeenCalledWith("/?c=chat-1");
  });

  it("agent-readiness: carries its own campaign segment + bootstrap (proves both campaigns)", async () => {
    seedIntent("agent-readiness");
    connectedWith("claude-code");
    await renderPage();
    await fireOnline("agent-2");

    const arg = onboardingMocks.postOnboardingStartChat.mock.calls[0]?.[0];
    if (!arg) throw new Error("expected a start-chat call");
    expect(arg).toMatchObject({ agentUuid: "agent-2", kind: "work", campaign: "agent-readiness", complete: false });
    expect(arg.bootstrap).toContain("github.com/acme/backend");
  });

  it("auto-picks the preferred runtime when two are present (no blocking picker)", async () => {
    seedIntent();
    connectedWith("claude-code", "codex");
    await renderPage();
    expect(agentCreationMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeProvider: "claude-code", visibility: "private", displayName: "Cedar" }),
    );
  });

  it("connected but no runtime → shows an install fallback and creates nothing", async () => {
    seedIntent();
    computerMock.value = {
      ...computerMock.value,
      connectedClient: hubClient(),
      capabilitiesLoaded: true,
      okRuntimes: [],
      selectedRuntime: null,
    };
    const container = await renderPage();
    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).toContain("Codex");
    expect(agentCreationMock.create).not.toHaveBeenCalled();
  });

  it("does not loop when the kickoff fails — surfaces an error + retry, called once, no navigate", async () => {
    seedIntent();
    connectedWith("claude-code");
    onboardingMocks.postOnboardingStartChat.mockRejectedValueOnce(new Error("server unavailable"));
    const container = await renderPage();
    await fireOnline("agent-1");

    expect(onboardingMocks.postOnboardingStartChat).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("server unavailable");
    expect(container.textContent?.toLowerCase()).toContain("try again");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("refreshes /me before navigating so the workspace gate sees the new agent (no bounce to onboarding)", async () => {
    seedIntent("production-scan");
    connectedWith("claude-code");
    await renderPage();
    await fireOnline("agent-1");

    expect(authMock.value.refreshMe).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/?c=chat-1");
  });

  it("agent-creation timeout surfaces an error + retry instead of spinning forever", async () => {
    seedIntent();
    connectedWith("claude-code");
    agentCreationMock.value = { phase: "timeout", error: null, createdUuid: "agent-x" };
    const container = await renderPage();
    expect(container.textContent?.toLowerCase()).toContain("try again");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("agent create failure → Try again actually re-attempts creation (not just a ref mutation)", async () => {
    seedIntent();
    connectedWith("claude-code");
    agentCreationMock.value = { phase: "idle", error: "agent service unavailable", createdUuid: null };
    const container = await renderPage();

    // Auto-create fired once; the error branch is shown with a retry.
    expect(agentCreationMock.create).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("agent service unavailable");

    const retryBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Try again"));
    if (!retryBtn) throw new Error("expected a Try again button");
    await act(async () => {
      retryBtn.click();
      await Promise.resolve();
    });
    // Clicking Try again must issue a second /agents attempt, not silently no-op.
    expect(agentCreationMock.create).toHaveBeenCalledTimes(2);
  });

  it("connect-token failure surfaces an error + retry on the connect step", async () => {
    seedIntent();
    computerMock.value = {
      ...computerMock.value,
      connectedClient: null,
      cliCommand: null,
      tokenError: "Couldn't generate your connect command",
    };
    const container = await renderPage();
    expect(container.textContent).toContain("Couldn't generate your connect command");
    expect(container.textContent?.toLowerCase()).toContain("try again");
  });

  it("missing campaign intent → renders a graceful pointer, creates nothing, never navigates", async () => {
    const container = await renderPage();
    expect(agentCreationMock.create).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect((container.textContent ?? "").length).toBeGreaterThan(0);
  });

  it("clears the stored campaign intent once start chat succeeds (no stale re-run on a bare revisit)", async () => {
    seedIntent();
    connectedWith("claude-code");
    await renderPage();
    await fireOnline("agent-1");
    expect(navigateMock).toHaveBeenCalledWith("/?c=chat-1");
    expect(readCampaignIntent()).toBeNull();
  });

  it("on remount with an already-created agent, reuses it (no duplicate Cedar) and resumes start chat", async () => {
    seedIntent("production-scan");
    connectedWith("claude-code");
    writeQuickstartAgentUuid("agent-existing");
    await renderPage();

    expect(agentCreationMock.create).not.toHaveBeenCalled();
    expect(onboardingMocks.postOnboardingStartChat).toHaveBeenCalledTimes(1);
    const arg = onboardingMocks.postOnboardingStartChat.mock.calls[0]?.[0];
    if (!arg) throw new Error("expected a start-chat call");
    expect(arg.agentUuid).toBe("agent-existing");
    expect(navigateMock).toHaveBeenCalledWith("/?c=chat-1");
  });
});
