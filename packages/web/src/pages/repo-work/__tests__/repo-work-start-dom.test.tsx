// @vitest-environment happy-dom

import type { AgentVisibility } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../../../api/activity.js";
import type { ComputerConnection } from "../../onboarding/use-computer-connection.js";
import { normalizeGitHubRepoUrl, writeRepoWorkIntent } from "../intent.js";
import { RepoWorkStartPage } from "../repo-work-start.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const navigateMock = vi.hoisted(() => vi.fn());

const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1",
    user: { username: "gandy" },
  },
}));

const computerMock = vi.hoisted(() => ({
  value: {
    connectedClient: null as ComputerConnection["connectedClient"],
    capabilitiesLoaded: false,
    okRuntimes: [] as string[],
    selectedRuntime: null as string | null,
    setSelectedRuntime: vi.fn(),
    cliCommand: "first-tree connect --token ft_test",
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
  value: {
    phase: "idle" as "idle" | "creating" | "online" | "timeout",
    error: null as string | null,
    createdUuid: null as string | null,
    retry: vi.fn(async () => undefined),
  },
}));

const onboardingMocks = vi.hoisted(() => ({
  kickoffOnboarding: vi.fn(async () => ({ chatId: "chat-repo-work" })),
  reportOnboardingEvent: vi.fn(async () => undefined),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("../../../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));

vi.mock("../../onboarding/use-computer-connection.js", () => ({
  useComputerConnection: () => computerMock.value,
}));

vi.mock("../../onboarding/use-agent-creation.js", () => ({
  useAgentCreation: () => ({
    ...agentCreationMock.value,
    create: agentCreationMock.create,
  }),
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

let root: Root | null = null;

function hubClient(overrides: Partial<HubClient> = {}): HubClient {
  return {
    id: "client-1",
    userId: "user-1",
    status: "connected",
    authState: "ok",
    binName: "first-tree",
    sdkVersion: "0.1.0",
    serverCommandVersion: null,
    hostname: "machine",
    os: "darwin",
    agentCount: 0,
    connectedAt: "2026-06-25T00:00:00.000Z",
    lastSeenAt: "2026-06-25T00:00:00.000Z",
    capabilities: {},
    ...overrides,
  };
}

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
    cliCommand: "first-tree connect --token ft_test",
    tokenError: null,
    retry: vi.fn(),
  };
  agentCreationMock.value = {
    phase: "idle",
    error: null,
    createdUuid: null,
    retry: vi.fn(async () => undefined),
  };
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
          <RepoWorkStartPage />
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

function seedIntent() {
  const intent = normalizeGitHubRepoUrl("https://github.com/acme/backend");
  if (!intent) throw new Error("expected valid intent");
  writeRepoWorkIntent(intent);
}

describe("RepoWorkStartPage", () => {
  it("shows a local-first setup prompt while waiting for the computer", async () => {
    seedIntent();

    const container = await renderPage();

    expect(container.textContent).toContain("acme/backend");
    expect(container.textContent).toContain("first-tree connect --token ft_test");
    expect(container.textContent).toContain("gh repo clone acme/backend");
    expect(agentCreationMock.create).not.toHaveBeenCalled();
  });

  it("auto-creates a private repo agent when computer and runtime are ready", async () => {
    seedIntent();
    computerMock.value = {
      ...computerMock.value,
      connectedClient: hubClient(),
      capabilitiesLoaded: true,
      okRuntimes: ["claude-code"],
      selectedRuntime: "claude-code",
    };

    await renderPage();

    expect(agentCreationMock.create).toHaveBeenCalledWith({
      displayName: "Backend agent",
      clientId: "client-1",
      runtimeProvider: "claude-code",
      visibility: "private",
      organizationId: "org-1",
    });
  });

  it("starts a repo_work kickoff chat when the created agent is online", async () => {
    seedIntent();
    agentCreationMock.value = {
      ...agentCreationMock.value,
      phase: "online",
      createdUuid: "agent-repo",
    };

    await renderPage();

    expect(onboardingMocks.kickoffOnboarding).toHaveBeenCalledWith({
      organizationId: "org-1",
      agentUuid: "agent-repo",
      kind: "repo_work",
      complete: true,
      bootstrap: expect.stringContaining("GitHub repo: https://github.com/acme/backend"),
    });
    expect(onboardingMocks.reportOnboardingEvent).toHaveBeenCalledWith("repo_work_kickoff_started", {
      agentUuid: "agent-repo",
      chatId: "chat-repo-work",
    });
    expect(navigateMock).toHaveBeenCalledWith("/?c=chat-repo-work");
  });

  it("does not loop retries when repo_work kickoff fails", async () => {
    seedIntent();
    onboardingMocks.kickoffOnboarding.mockRejectedValueOnce(new Error("server unavailable"));
    agentCreationMock.value = {
      ...agentCreationMock.value,
      phase: "online",
      createdUuid: "agent-repo",
    };

    const container = await renderPage();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onboardingMocks.kickoffOnboarding).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("server unavailable");
    expect(container.textContent).toContain("Retry");
  });
});
