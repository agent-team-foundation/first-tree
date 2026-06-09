// @vitest-environment happy-dom

import type { MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingFlowProvider, type OnboardingFlowValue, useOnboardingFlow } from "../onboarding-flow.js";
import { useAgentCreation } from "../use-agent-creation.js";
import type { ComputerConnection } from "../use-computer-connection.js";
import { useComputerConnection } from "../use-computer-connection.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function expectHookValue<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error("hook value was not captured");
  return value;
}

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

const authMock = vi.hoisted(() => ({
  value: {
    isAuthenticated: true,
    meLoaded: true,
    user: { id: "user-self", username: "gandy", displayName: "Gandy", avatarUrl: null },
    memberships: [] as MeMembership[],
    currentMembership: null as MeMembership | null,
    organizationId: "org-1",
    memberId: "member-self",
    role: "admin",
    agentId: "human-agent-self",
    teamDisplayName: "Acme",
    orgHasOtherMembers: true,
    onboardingStep: "connect" as const,
    onboardingDismissedAt: null,
    onboardingCompletedAt: null,
    dismissOnboarding: vi.fn(async () => undefined),
    restoreOnboarding: vi.fn(async () => undefined),
    markOnboardingCompleted: vi.fn(async () => undefined),
    login: vi.fn(async () => undefined),
    adoptTokens: vi.fn(async () => undefined),
    selectOrganization: vi.fn(async () => undefined),
    refreshMe: vi.fn(async () => undefined),
    logout: vi.fn(),
  },
}));

vi.mock("../../../api/activity.js", () => activityMocks);
vi.mock("../../../api/agent-config.js", () => agentConfigMocks);
vi.mock("../../../api/client.js", () => clientMocks);
vi.mock("../../../api/onboarding-events.js", () => eventMocks);
vi.mock("../../../lib/visibility-interval.js", () => visibilityMocks);
vi.mock("../../../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

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

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = "";
  const storage = createStorage();
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: createStorage() });
  authMock.value = {
    ...authMock.value,
    role: "admin",
    onboardingStep: "connect",
    dismissOnboarding: vi.fn(async () => undefined),
    markOnboardingCompleted: vi.fn(async () => undefined),
    refreshMe: vi.fn(async () => undefined),
  };
  root = null;
  container = null;
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

async function renderProbe(element: ReactNode, route = "/onboarding"): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[route]}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          {element}
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return container;
}

describe("onboarding hooks and flow", () => {
  it("detects connected computers, capabilities, preferred runtime, and command token failures", async () => {
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

    await act(async () => expectHookValue(latest.current).setSelectedRuntime("manual"));
    expect(expectHookValue(latest.current).selectedRuntime).toBe("manual");

    await act(async () => root?.unmount());
    root = null;
    activityMocks.listClients.mockResolvedValue([]);
    // All mint attempts fail. The hook retries silently a few times (with
    // backoff) before surfacing the error, so reject persistently and wait the
    // backoff window out before asserting.
    clientMocks.api.post.mockRejectedValue(new Error("token failed"));
    await renderProbe(<Probe />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2400));
    });
    expect(expectHookValue(latest.current).tokenError).toBe("token failed");
  }, 10_000);

  it("creates an agent, stores its uuid, reports onboarding, and reaches online", async () => {
    const latest = { current: null as ReturnType<typeof useAgentCreation> | null };
    const onOnline = vi.fn();
    clientMocks.api.post.mockResolvedValueOnce({ uuid: "agent-created" });
    agentConfigMocks.getAgentClientStatus
      .mockResolvedValueOnce({ online: false })
      .mockResolvedValueOnce({ online: true });

    function Probe() {
      latest.current = useAgentCreation(onOnline);
      return <div>{latest.current.phase}</div>;
    }

    await renderProbe(<Probe />);
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
    expect(sessionStorage.getItem("onboarding:agentUuid")).toBe("agent-created");
    expect(eventMocks.reportOnboardingEvent).toHaveBeenCalledWith("agent_created", { runtimeProvider: "claude-code" });
    expect(onOnline).toHaveBeenCalledWith("agent-created");
    expect(expectHookValue(latest.current).phase).toBe("online");
  });

  it("handles create errors, blank names, retry, and timeout", async () => {
    vi.useFakeTimers();
    const latest = { current: null as ReturnType<typeof useAgentCreation> | null };
    clientMocks.api.post
      .mockRejectedValueOnce(new Error("create failed"))
      .mockResolvedValueOnce({ uuid: "agent-slow" });
    agentConfigMocks.getAgentClientStatus.mockResolvedValue({ online: false });

    function Probe() {
      latest.current = useAgentCreation(() => undefined);
      return <div>{latest.current.phase}</div>;
    }

    await renderProbe(<Probe />);
    await act(async () => {
      await expectHookValue(latest.current).create({
        displayName: "   ",
        clientId: "client-1",
        runtimeProvider: "claude-code",
        visibility: "private",
        organizationId: null,
      });
    });
    expect(clientMocks.api.post).not.toHaveBeenCalled();

    await act(async () => {
      await expectHookValue(latest.current).create({
        displayName: "Broken",
        clientId: "client-1",
        runtimeProvider: "claude-code",
        visibility: "private",
        organizationId: null,
      });
    });
    expect(expectHookValue(latest.current).error).toBe("create failed");
    expect(expectHookValue(latest.current).phase).toBe("idle");

    const slowCreate = act(async () => {
      const promise = expectHookValue(latest.current).create({
        displayName: "Slow Bot",
        clientId: "client-1",
        runtimeProvider: "codex",
        visibility: "private",
        organizationId: null,
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(31_000);
      await promise;
    });
    await slowCreate;
    expect(expectHookValue(latest.current).phase).toBe("timeout");

    const retry = act(async () => {
      const promise = expectHookValue(latest.current).retry();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(31_000);
      await promise;
    });
    await retry;
    expect(expectHookValue(latest.current).phase).toBe("timeout");
  });

  it("persists flow progress and navigates on finish actions", async () => {
    const latest = { current: null as OnboardingFlowValue | null };

    function Probe() {
      function Inner() {
        latest.current = useOnboardingFlow();
        return <div>{latest.current.activeStep}</div>;
      }
      return (
        <OnboardingFlowProvider path="admin">
          <Inner />
        </OnboardingFlowProvider>
      );
    }

    const host = await renderProbe(<Probe />);
    expect(host.textContent).toContain("team");
    await act(async () => expectHookValue(latest.current).goTo(1));
    expect(expectHookValue(latest.current).activeStep).toBe("connect-computer");
    expect(sessionStorage.getItem("onboarding:stepIndex:admin")).toBe("1");

    await act(async () => expectHookValue(latest.current).finishLater());
    expect(authMock.value.dismissOnboarding).toHaveBeenCalled();

    await act(async () => expectHookValue(latest.current).completeAndEnterChat("chat 1"));
    expect(authMock.value.dismissOnboarding).toHaveBeenCalledTimes(2);
    expect(authMock.value.markOnboardingCompleted).toHaveBeenCalled();
    expect(sessionStorage.getItem("onboarding:stepIndex:admin")).toBeNull();
  });
});
