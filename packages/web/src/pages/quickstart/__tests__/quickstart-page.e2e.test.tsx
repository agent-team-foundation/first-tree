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
import { type CampaignIntent, readCampaignIntent, writeCampaignIntent, writeQuickstartAgent } from "../intent.js";
import { QuickstartPage } from "../quickstart-page.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const navigateMock = vi.hoisted(() => vi.fn());
const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1" as string | null,
    user: { username: "gandy" },
    refreshMe: vi.fn(async () => undefined),
    currentOrgHasPersonalAgent: false,
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
  // Captures the `enabled` arg the page passes to useComputerConnection so a
  // test can assert the channel gate keeps the connection off in prod/loading.
  lastEnabled: undefined as boolean | undefined,
}));

const channelMock = vi.hoisted(() => ({
  value: { channel: "dev" as "dev" | "staging" | "prod" | null, settled: true },
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
const agentsListMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const updateAgentMock = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useNavigate: () => navigateMock };
});
vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../../features/agent-setup/use-computer-connection.js", () => ({
  useComputerConnection: (enabled: boolean) => {
    computerMock.lastEnabled = enabled;
    return computerMock.value;
  },
}));
vi.mock("../../../hooks/use-server-channel.js", () => ({
  useServerChannelState: () => channelMock.value,
  useServerChannel: () => channelMock.value.channel,
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
vi.mock("../../../api/agents.js", () => ({ listManagedAgents: agentsListMock, updateAgent: updateAgentMock }));

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
  authMock.value = {
    organizationId: "org-1",
    user: { username: "gandy" },
    refreshMe: vi.fn(async () => undefined),
    currentOrgHasPersonalAgent: false,
  };
  agentsListMock.mockReset();
  agentsListMock.mockResolvedValue([]);
  updateAgentMock.mockReset();
  updateAgentMock.mockResolvedValue({});
  // Default to dev (allowed + settled) so existing flow tests run unchanged;
  // the channel-gate tests override this per case.
  channelMock.value = { channel: "dev", settled: true };
  computerMock.lastEnabled = undefined;
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
    writeQuickstartAgent({ campaign: "production-scan", organizationId: "org-1", uuid: "agent-existing" });
    await renderPage();

    expect(agentCreationMock.create).not.toHaveBeenCalled();
    expect(onboardingMocks.postOnboardingStartChat).toHaveBeenCalledTimes(1);
    const arg = onboardingMocks.postOnboardingStartChat.mock.calls[0]?.[0];
    if (!arg) throw new Error("expected a start-chat call");
    expect(arg.agentUuid).toBe("agent-existing");
    expect(navigateMock).toHaveBeenCalledWith("/?c=chat-1");
  });

  it("ignores a stale stashed agent from a different campaign and creates fresh instead of resuming", async () => {
    seedIntent("production-scan");
    connectedWith("claude-code");
    // Stash left over from a DIFFERENT campaign (abandoned earlier attempt).
    writeQuickstartAgent({ campaign: "agent-readiness", organizationId: "org-1", uuid: "stale-agent" });
    await renderPage();

    // The mismatched stash is ignored → a fresh Cedar is created, and we do NOT
    // resume start chat against the inaccessible stale agent.
    expect(agentCreationMock.create).toHaveBeenCalledTimes(1);
    expect(onboardingMocks.postOnboardingStartChat).not.toHaveBeenCalled();
  });

  it("campaign B after campaign A reuses the existing agent as-is (names it, not Cedar; no client move, no duplicate create)", async () => {
    // Returning user: campaign A already created their agent, so /me reports a
    // personal agent and there is no per-tab stash (cleared on A's success). A
    // second create of "Cedar" would slugify to "cedar" and hit the (org, name)
    // unique constraint, so the page reuses the existing agent. Its client is
    // immutable once set (the server allows clientId NULL -> ID only), so the
    // page must NOT try to move the agent onto the just-connected machine — it
    // reuses the agent on its own client (the cross-machine "runs elsewhere"
    // case is a v0-accepted follow-up). The dual-reader bootstrap names THAT
    // agent, not "Cedar".
    seedIntent("agent-readiness");
    connectedWith("claude-code"); // connected client id = "client-1"
    authMock.value = {
      organizationId: "org-1",
      user: { username: "gandy" },
      refreshMe: vi.fn(async () => undefined),
      currentOrgHasPersonalAgent: true,
    };
    agentsListMock.mockResolvedValue([
      {
        uuid: "existing-cedar",
        displayName: "Gandy assistant",
        type: "agent",
        status: "active",
        organizationId: "org-1",
        clientId: "old-client",
      },
    ]);

    await renderPage();
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    // Reuses the existing agent; never POSTs a second "cedar" (which would 409).
    expect(agentCreationMock.create).not.toHaveBeenCalled();
    // The agent is pinned to another client ("old-client"); since clientId is
    // immutable once set, the page must NOT attempt to move it (the server
    // would reject ID -> ID) — it reuses the agent on its own client.
    expect(updateAgentMock).not.toHaveBeenCalled();
    expect(onboardingMocks.postOnboardingStartChat).toHaveBeenCalledTimes(1);
    const arg = onboardingMocks.postOnboardingStartChat.mock.calls[0]?.[0];
    if (!arg) throw new Error("expected a start-chat call");
    expect(arg.agentUuid).toBe("existing-cedar");
    expect(arg.campaign).toBe("agent-readiness");
    // Dual-reader copy names the REUSED agent, not Cedar.
    expect(arg.bootstrap).toContain("Gandy assistant");
    expect(arg.bootstrap).not.toContain("Cedar");
    expect(navigateMock).toHaveBeenCalledWith("/?c=chat-1");
  });

  it("prod channel: redirects home and fires no connect/agent side effects", async () => {
    // Even a fully connected computer with a usable runtime must not set up in
    // prod — the gate blocks the whole flow (connection enable + setup effect)
    // and sends the user home.
    channelMock.value = { channel: "prod", settled: true };
    seedIntent("production-scan");
    connectedWith("claude-code");
    await renderPage();
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
    expect(computerMock.lastEnabled).toBe(false); // connection never enabled in prod
    expect(agentCreationMock.create).not.toHaveBeenCalled();
    expect(onboardingMocks.postOnboardingStartChat).not.toHaveBeenCalled();
  });

  it("unknown channel (old server / unreadable): treated as prod — redirects, creates nothing", async () => {
    channelMock.value = { channel: null, settled: true };
    seedIntent("production-scan");
    connectedWith("claude-code");
    await renderPage();
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    expect(navigateMock).toHaveBeenCalledWith("/", { replace: true });
    expect(agentCreationMock.create).not.toHaveBeenCalled();
  });

  it("channel still loading: holds a neutral screen, no redirect, no side effects", async () => {
    channelMock.value = { channel: null, settled: false };
    seedIntent("production-scan");
    connectedWith("claude-code");
    const container = await renderPage();
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    expect(navigateMock).not.toHaveBeenCalled(); // must NOT bounce a dev/staging user mid-fetch
    expect(computerMock.lastEnabled).toBe(false); // connection waits until the channel settles
    expect(agentCreationMock.create).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("npx @first-tree/cli login"); // not the connect step
  });

  it("staging channel: allowed — connection enabled, no redirect", async () => {
    channelMock.value = { channel: "staging", settled: true };
    seedIntent("production-scan");
    await renderPage();
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(computerMock.lastEnabled).toBe(true);
  });
});
