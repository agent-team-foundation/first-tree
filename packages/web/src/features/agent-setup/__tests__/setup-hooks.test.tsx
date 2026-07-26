// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentCreation } from "../use-agent-creation.js";
import type { ComputerConnection } from "../use-computer-connection.js";
import { useComputerConnection } from "../use-computer-connection.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({
  getClientCapabilities: vi.fn(),
  listClients: vi.fn(),
}));

const agentConfigMocks = vi.hoisted(() => ({
  getAgentClientStatus: vi.fn(),
}));

const clientMocks = vi.hoisted(() => ({
  api: {
    post: vi.fn(),
  },
  withOrg: vi.fn((path: string) => `/orgs/org-1${path}`),
}));

const eventMocks = vi.hoisted(() => ({
  reportOnboardingEvent: vi.fn(),
}));

const visibilityMocks = vi.hoisted(() => ({
  runVisibilityAwareInterval: vi.fn((tick: () => void | Promise<void>) => {
    void tick();
    return vi.fn();
  }),
}));

vi.mock("../../../api/activity.js", () => activityMocks);
vi.mock("../../../api/agent-config.js", () => agentConfigMocks);
vi.mock("../../../api/client.js", () => clientMocks);
vi.mock("../../../api/onboarding-events.js", () => eventMocks);
vi.mock("../../../lib/visibility-interval.js", () => visibilityMocks);

let root: Root | null = null;
const PROD_INSTALLER_URL = "https://download.first-tree.ai/releases/prod/install.sh";
const bootstrapCommand = (token: string): string =>
  `curl -fsSL ${PROD_INSTALLER_URL} | sh\n~/.local/bin/first-tree login ${token}`;

function expectHookValue<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error("hook value was not captured");
  return value;
}

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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function renderProbe(element: ReactNode, queryClient: QueryClient = testQueryClient()): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={["/test"]}>
        <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = "";
  const storage = createStorage();
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("shared setup hooks", () => {
  it("detects connected computers and picks a ready runtime without onboarding state", async () => {
    const latest = { current: null as ComputerConnection | null };
    const client = {
      id: "client-1",
      userId: "user-self",
      status: "connected",
      authState: "ok",
      binName: "first-tree-dev",
      sdkVersion: "0.5.0",
      hostname: "gandy-macbook",
      os: "darwin",
      agentCount: 1,
      connectedAt: "2026-05-28T00:00:00.000Z",
      lastSeenAt: "2026-05-28T12:00:00.000Z",
      capabilities: {},
    };
    activityMocks.listClients.mockResolvedValue([client]);
    activityMocks.getClientCapabilities.mockResolvedValue({
      ...client,
      capabilities: {
        codex: {
          state: "ok",
          available: true,
          authenticated: true,
          authMethod: "api_key",
          detectedAt: "2026-05-28T12:00:00.000Z",
        },
        "claude-code": {
          state: "unauthenticated",
          available: true,
          authenticated: false,
          authMethod: "none",
          detectedAt: "2026-05-28T12:00:00.000Z",
        },
      },
    });

    function Probe() {
      latest.current = useComputerConnection(true);
      return <div>{latest.current.selectedRuntime ?? "none"}</div>;
    }

    await renderProbe(<Probe />);
    await flush();
    await flush();

    expect(expectHookValue(latest.current).connectedClient?.id).toBe("client-1");
    expect(expectHookValue(latest.current).capabilitiesLoaded).toBe(true);
    expect(expectHookValue(latest.current).okRuntimes).toEqual(["codex"]);
    expect(expectHookValue(latest.current).selectedRuntime).toBe("codex");
    expect(sessionStorage.getItem("onboarding:agentUuid")).toBeNull();
    expect(eventMocks.reportOnboardingEvent).not.toHaveBeenCalled();
  });

  it("keeps an empty capability snapshot in detecting state until a provider report arrives", async () => {
    const latest = { current: null as ComputerConnection | null };
    const client = {
      id: "client-1",
      userId: "user-self",
      status: "connected",
      authState: "ok",
      binName: "first-tree-dev",
      sdkVersion: "0.5.0",
      hostname: "gandy-macbook",
      os: "darwin",
      agentCount: 0,
      connectedAt: "2026-05-28T00:00:00.000Z",
      lastSeenAt: "2026-05-28T12:00:00.000Z",
      capabilities: {},
    };
    activityMocks.listClients.mockResolvedValue([client]);
    activityMocks.getClientCapabilities.mockResolvedValueOnce({ ...client, capabilities: {} }).mockResolvedValueOnce({
      ...client,
      capabilities: {
        codex: {
          state: "ok",
          available: true,
          authenticated: true,
          authMethod: "none",
          detectedAt: "2026-05-28T12:00:05.000Z",
        },
      },
    });

    function Probe() {
      latest.current = useComputerConnection(true);
      return <div>{latest.current.selectedRuntime ?? "none"}</div>;
    }

    await renderProbe(<Probe />);
    await flush();
    await flush();

    expect(expectHookValue(latest.current).connectedClient?.id).toBe("client-1");
    expect(expectHookValue(latest.current).capabilitiesLoaded).toBe(false);
    expect(expectHookValue(latest.current).okRuntimes).toEqual([]);
    expect(expectHookValue(latest.current).selectedRuntime).toBeNull();

    const tick = visibilityMocks.runVisibilityAwareInterval.mock.calls[0]?.[0];
    if (!tick) throw new Error("visibility-aware interval was not registered");
    await act(async () => {
      await tick();
    });
    await flush();

    expect(expectHookValue(latest.current).capabilitiesLoaded).toBe(true);
    expect(expectHookValue(latest.current).okRuntimes).toEqual(["codex"]);
    expect(expectHookValue(latest.current).selectedRuntime).toBe("codex");
  });

  it("keeps prior runtime choice and falls back to enabled future providers after transient capability failures", async () => {
    const latest = { current: null as ComputerConnection | null };
    const client = {
      id: "client-1",
      userId: "user-self",
      status: "connected",
      authState: "ok",
      binName: "first-tree-dev",
      sdkVersion: "0.5.0",
      hostname: "gandy-macbook",
      os: "darwin",
      agentCount: 0,
      connectedAt: "2026-05-28T00:00:00.000Z",
      lastSeenAt: "2026-05-28T12:00:00.000Z",
      capabilities: {},
    };
    activityMocks.listClients.mockResolvedValue([client]);
    activityMocks.getClientCapabilities.mockRejectedValueOnce(new Error("capabilities offline")).mockResolvedValue({
      ...client,
      capabilities: {
        "claude-code-tui": {
          state: "ok",
          available: true,
          detectedAt: "2026-05-28T12:00:00.000Z",
        },
        "future-provider": {
          state: "ok",
          available: true,
          detectedAt: "2026-05-28T12:00:00.000Z",
        },
      },
    });

    function Probe() {
      latest.current = useComputerConnection(true);
      return <div>{latest.current.selectedRuntime ?? "none"}</div>;
    }

    await renderProbe(<Probe />);
    await flush();
    await flush();

    expect(expectHookValue(latest.current).capabilitiesLoaded).toBe(false);

    const tick = visibilityMocks.runVisibilityAwareInterval.mock.calls[0]?.[0];
    if (!tick) throw new Error("visibility-aware interval was not registered");
    await act(async () => {
      await tick();
    });
    await flush();

    expect(expectHookValue(latest.current).capabilitiesLoaded).toBe(true);
    expect(expectHookValue(latest.current).okRuntimes).toEqual(["future-provider"]);
    expect(expectHookValue(latest.current).selectedRuntime).toBe("future-provider");

    await act(async () => expectHookValue(latest.current).setSelectedRuntime("future-provider"));
    activityMocks.getClientCapabilities.mockResolvedValueOnce({
      ...client,
      capabilities: {
        "future-provider": {
          state: "ok",
          available: true,
          detectedAt: "2026-05-28T12:00:05.000Z",
        },
        codex: {
          state: "ok",
          available: true,
          detectedAt: "2026-05-28T12:00:05.000Z",
        },
      },
    });
    await act(async () => {
      await tick();
    });
    await flush();

    expect(expectHookValue(latest.current).selectedRuntime).toBe("future-provider");
  });

  it("mints connect commands, surfaces final token failures, and retries manually", async () => {
    const latest = { current: null as ComputerConnection | null };
    const onTokenMintFailed = vi.fn();
    activityMocks.listClients.mockResolvedValue([]);
    clientMocks.api.post
      .mockResolvedValueOnce({
        token: "token-1",
        expiresIn: 600,
        command: "first-tree login token-1",
        bootstrapCommand: bootstrapCommand("token-1"),
        installerUrl: PROD_INSTALLER_URL,
        binName: "first-tree",
      })
      .mockRejectedValueOnce(new Error("token retry failed"))
      .mockRejectedValueOnce("still down")
      .mockRejectedValueOnce(new Error("token failed"))
      .mockResolvedValueOnce({
        token: "token-2",
        expiresIn: 600,
        command: "first-tree login token-2",
        bootstrapCommand: bootstrapCommand("token-2"),
        installerUrl: PROD_INSTALLER_URL,
        binName: "first-tree",
      });

    function Probe() {
      latest.current = useComputerConnection(true, { onTokenMintFailed });
      return <div>{latest.current.cliCommand ?? latest.current.tokenError ?? "pending"}</div>;
    }

    await renderProbe(<Probe />);
    await flush();
    await flush();

    expect(expectHookValue(latest.current).cliCommand).toBe(bootstrapCommand("token-1"));

    await act(async () => expectHookValue(latest.current).retry());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2400));
    });

    expect(expectHookValue(latest.current).tokenError).toBe("token failed");
    expect(onTokenMintFailed).toHaveBeenCalledTimes(1);

    await act(async () => expectHookValue(latest.current).retry());
    await flush();
    await flush();

    expect(expectHookValue(latest.current).cliCommand).toBe(bootstrapCommand("token-2"));
    expect(expectHookValue(latest.current).tokenError).toBeNull();
  }, 10_000);

  it("creates an agent and reports lifecycle through callbacks only", async () => {
    const latest = { current: null as ReturnType<typeof useAgentCreation> | null };
    const onOnline = vi.fn();
    const onCreated = vi.fn();
    const queryClient = testQueryClient();
    const rosterKey = ["agents", "org-list", { addressableOnly: true }] as const;
    queryClient.setQueryData(rosterKey, {
      items: [{ uuid: "human-agent-self", type: "human", delegateMention: null }],
      nextCursor: null,
    });
    clientMocks.api.post.mockResolvedValueOnce({ uuid: "agent-created" });
    agentConfigMocks.getAgentClientStatus
      .mockResolvedValueOnce({ online: false })
      .mockResolvedValueOnce({ online: true });

    function Probe() {
      latest.current = useAgentCreation({ onCreated, onOnline });
      return <div>{latest.current.phase}</div>;
    }

    await renderProbe(<Probe />, queryClient);
    await act(async () => {
      await expectHookValue(latest.current).create({
        displayName: "Deploy Bot",
        clientId: "client-1",
        runtimeProvider: "claude-code",
        visibility: "organization",
        organizationId: "org-1",
      });
    });

    expect(clientMocks.api.post).toHaveBeenCalledWith(
      "/orgs/org-1/agents",
      expect.objectContaining({
        displayName: "Deploy Bot",
        name: "deploy-bot",
        clientId: "client-1",
        runtimeProvider: "claude-code",
      }),
    );
    expect(onCreated).toHaveBeenCalledWith({
      agentUuid: "agent-created",
      args: expect.objectContaining({ runtimeProvider: "claude-code" }),
    });
    expect(onOnline).toHaveBeenCalledWith("agent-created");
    expect(queryClient.getQueryState(rosterKey)?.isInvalidated).toBe(true);
    expect(expectHookValue(latest.current).phase).toBe("online");
    expect(sessionStorage.getItem("onboarding:agentUuid")).toBeNull();
    expect(eventMocks.reportOnboardingEvent).not.toHaveBeenCalled();
  });
});
