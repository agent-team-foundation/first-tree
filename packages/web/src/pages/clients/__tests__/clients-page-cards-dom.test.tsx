// @vitest-environment happy-dom

import type { CapabilityEntry } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { ApiError } from "../../../api/client.js";
import { ToastProvider } from "../../../components/ui/toast.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({
  disconnectClient: vi.fn(),
  generateConnectToken: vi.fn(),
  getActivityOverview: vi.fn(),
  listClients: vi.fn(),
  listOrgClients: vi.fn(),
  retireClient: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    role: "admin",
    user: { id: "user-self", username: "gandy", displayName: "Gandy", avatarUrl: null },
  },
}));

const memberMocks = vi.hoisted(() => ({
  listMembers: vi.fn(),
}));

vi.mock("../../../api/activity.js", () => activityMocks);

vi.mock("../../../api/members.js", () => memberMocks);

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../lib/use-agent-name-map.js", () => ({
  useAgentNameMap: () => (id: string | null | undefined) => (id ? (AGENT_NAMES[id] ?? id) : "unknown"),
}));

vi.mock("../../../lib/visibility-interval.js", () => ({
  runVisibilityAwareInterval: (tick: () => void | Promise<void>) => {
    void tick();
    return () => undefined;
  },
}));

const NOW = "2026-05-28T12:00:00.000Z";

const AGENT_NAMES: Record<string, string> = {
  "agent-1": "Nova",
  "agent-2": "Design Critique",
  "agent-3": "Codex Runner",
  "agent-4": "Offline Worker",
};

function okCapability(sdkVersion = "0.2.84"): CapabilityEntry {
  return {
    state: "ok",
    available: true,
    authenticated: true,
    sdkVersion,
    authMethod: "oauth",
    detectedAt: NOW,
  };
}

function missingCapability(): CapabilityEntry {
  return {
    state: "missing",
    available: false,
    authenticated: false,
    sdkVersion: null,
    authMethod: "none",
    detectedAt: NOW,
  };
}

function unauthCapability(sdkVersion = "0.134.0"): CapabilityEntry {
  return {
    state: "unauthenticated",
    available: true,
    authenticated: false,
    sdkVersion,
    authMethod: "none",
    detectedAt: NOW,
  };
}

function errorCapability(): CapabilityEntry {
  return {
    state: "error",
    available: false,
    authenticated: false,
    sdkVersion: null,
    authMethod: "none",
    detectedAt: NOW,
    error: "probe failed",
  };
}

function client(overrides: Partial<HubClient> = {}): HubClient {
  return {
    id: overrides.id ?? "client-ready",
    userId: overrides.userId ?? "user-self",
    status: overrides.status ?? "connected",
    authState: overrides.authState ?? "ok",
    binName: overrides.binName ?? "first-tree-dev",
    sdkVersion: overrides.sdkVersion ?? "0.5.0",
    ...(overrides.serverCommandVersion !== undefined ? { serverCommandVersion: overrides.serverCommandVersion } : {}),
    hostname: overrides.hostname ?? "gandy-macbook",
    os: overrides.os ?? "darwin",
    agentCount: overrides.agentCount ?? 1,
    connectedAt: overrides.connectedAt ?? NOW,
    lastSeenAt: overrides.lastSeenAt ?? NOW,
    capabilities:
      overrides.capabilities ??
      ({
        "claude-code": okCapability(),
        codex: unauthCapability(),
      } satisfies HubClient["capabilities"]),
  };
}

const READY = client();
const AUTH_EXPIRED = client({
  id: "client-expired",
  hostname: "expired-mac",
  status: "disconnected",
  authState: "expired",
  connectedAt: null,
  lastSeenAt: "2026-05-27T09:00:00.000Z",
  capabilities: { "claude-code": okCapability("0.2.70") },
});
const SETUP_INCOMPLETE = client({
  id: "client-setup",
  hostname: "fresh-linux",
  os: "linux",
  agentCount: 1,
  capabilities: {
    "claude-code": missingCapability(),
    "claude-code-tui": errorCapability(),
    codex: unauthCapability(),
  },
});
const OFFLINE = client({
  id: "client-offline",
  hostname: "offline-box",
  status: "disconnected",
  connectedAt: null,
  lastSeenAt: "2026-05-26T09:00:00.000Z",
  capabilities: { "claude-code": okCapability("0.2.84") },
});
const TEAM = client({
  id: "client-team",
  userId: "user-alice",
  hostname: "alice-linux",
  os: "linux",
  agentCount: 1,
});

const AGENTS: RuntimeAgent[] = [
  {
    agentId: "agent-1",
    clientId: READY.id,
    runtimeType: "claude-code",
    runtimeState: "idle",
    activeSessions: 1,
    totalSessions: 2,
    runtimeUpdatedAt: NOW,
    type: "agent",
    managedByMe: true,
  },
  {
    agentId: "agent-2",
    clientId: SETUP_INCOMPLETE.id,
    runtimeType: "codex",
    runtimeState: null,
    activeSessions: 0,
    totalSessions: 0,
    runtimeUpdatedAt: NOW,
    type: "agent",
    managedByMe: true,
  },
  {
    agentId: "agent-4",
    clientId: OFFLINE.id,
    runtimeType: "claude-code",
    runtimeState: null,
    activeSessions: 0,
    totalSessions: 3,
    runtimeUpdatedAt: NOW,
    type: "agent",
    managedByMe: true,
  },
];

function installBrowserStubs(): void {
  const storage = createStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("48rem") || query.includes("80rem"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
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
    removeItem: (key: string) => data.delete(key),
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

async function renderDom(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = createClient();
  await act(async () => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>{element}</ToastProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForText(container: ParentNode, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}"`);
}

async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function exactButton(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === text) ?? null;
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

function copyButtonForCommand(container: ParentNode, command: string): HTMLButtonElement | null {
  const pre = [...container.querySelectorAll("pre")].find((node) => node.textContent?.includes(command));
  return pre?.parentElement?.querySelector("button") ?? null;
}

function seedDefaultMocks(): void {
  activityMocks.listOrgClients.mockResolvedValue([READY, AUTH_EXPIRED, SETUP_INCOMPLETE, OFFLINE, TEAM]);
  activityMocks.listClients.mockResolvedValue([READY, AUTH_EXPIRED, SETUP_INCOMPLETE, OFFLINE]);
  activityMocks.getActivityOverview.mockResolvedValue({
    clients: 5,
    agents: AGENTS,
    running: 1,
    total: 4,
    byState: {},
  });
  activityMocks.disconnectClient.mockResolvedValue({ disconnected: true, agentIds: ["agent-1"] });
  activityMocks.retireClient.mockResolvedValue(undefined);
  activityMocks.generateConnectToken.mockResolvedValue({
    token: "connect-token",
    expiresIn: 600,
    command: "first-tree-dev login connect-token",
    bootstrapCommand: "first-tree-dev login connect-token",
    npmSpec: null,
    binName: "first-tree-dev",
  });
  memberMocks.listMembers.mockResolvedValue([
    { userId: "user-self", displayName: "Gandy" },
    { userId: "user-alice", displayName: "Alice" },
  ]);
}

beforeEach(() => {
  installBrowserStubs();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value = {
    role: "admin",
    user: { id: "user-self", username: "gandy", displayName: "Gandy", avatarUrl: null },
  };
  seedDefaultMocks();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ClientsPage computer cards", () => {
  it("renders admin cards, team table, action dialogs, runtime commands, and connect dialog", async () => {
    const { ClientsPage } = await import("../../clients.js");
    const { container, root } = await renderDom(<ClientsPage />);

    await waitForText(container, "Your computers");
    await waitForText(container, "gandy-macbook");
    await waitForText(container, "expired-mac");
    await waitForText(container, "fresh-linux");
    await waitForText(container, "offline-box");
    await waitForText(container, "Ready");
    await waitForText(container, "Auth expired");
    await waitForText(container, "Setup incomplete");
    await waitForText(container, "Offline");
    await waitForText(container, "Install a runtime to start");
    await waitForText(container, "npm install -g @anthropic-ai/claude-code");
    await waitForText(container, "probe failed");

    await click(buttonByText(container, "Daemon not running?"));
    await waitForText(container, "first-tree-dev daemon start");
    await click(copyButtonForCommand(container, "first-tree-dev daemon start"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("first-tree-dev daemon start");

    await click(exactButton(container, "Show"));
    await waitForText(container, "Team computers");
    await waitForText(container, "alice-linux");
    await waitForText(container, "Alice");
    await click(exactButton(container, "Hide"));

    await click(container.querySelector('button[aria-label="Computer actions"]'));
    await waitForText(container, "Disconnect");
    await click(exactButton(container, "Disconnect"));
    await waitForText(document.body, "Disconnect Computer");
    await click(
      [...document.body.querySelectorAll("button")].reverse().find((button) => button.textContent === "Disconnect") ??
        null,
    );
    await waitForCondition(() => activityMocks.disconnectClient.mock.calls.length > 0, "Expected disconnect");
    expect(activityMocks.disconnectClient.mock.calls[0]?.[0]).toBe(AUTH_EXPIRED.id);

    await click(container.querySelector('button[aria-label="Computer actions"]'));
    await click(exactButton(container, "Retire"));
    await waitForText(document.body, "Retire Computer");
    await waitForText(document.body, "Nova");
    activityMocks.retireClient.mockRejectedValueOnce(new ApiError(409, "delete pinned agents first"));
    await click(
      [...document.body.querySelectorAll("button")].reverse().find((button) => button.textContent === "Retire") ?? null,
    );
    await waitForText(document.body, "delete pinned agents first");
    activityMocks.retireClient.mockResolvedValueOnce(undefined);
    await click(
      [...document.body.querySelectorAll("button")].reverse().find((button) => button.textContent === "Retire") ?? null,
    );
    await waitForCondition(() => activityMocks.retireClient.mock.calls.length >= 2, "Expected retire retry");
    expect(activityMocks.retireClient.mock.calls.at(-1)?.[0]).toBe(AUTH_EXPIRED.id);

    await click(exactButton(container, "Generate new token"));
    await waitForText(document.body, "Re-authenticate computer");
    await waitForText(document.body, "first-tree-dev login connect-token");
    await click(copyButtonForCommand(document.body, "first-tree-dev login connect-token"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("first-tree-dev login connect-token");
    await click(exactButton(document.body, "Cancel"));

    await click(exactButton(container, "Connect"));
    await waitForText(document.body, "Connect computer");
    await click(exactButton(document.body, "Cancel"));

    await act(async () => root.unmount());
  });

  it("shows the server-reported update target when a computer is behind", async () => {
    const { ClientsPage } = await import("../../clients.js");
    const updating = client({
      id: "client-update",
      hostname: "needs-update",
      sdkVersion: "0.5.0",
      serverCommandVersion: "0.6.0",
    });
    activityMocks.listOrgClients.mockResolvedValueOnce([updating]);
    activityMocks.listClients.mockResolvedValueOnce([updating]);
    activityMocks.getActivityOverview.mockResolvedValueOnce({
      clients: 1,
      agents: [],
      running: 0,
      total: 0,
      byState: {},
    });

    const { container, root } = await renderDom(<ClientsPage />);

    await waitForText(container, "needs-update");
    await waitForText(container, "Update available 0.6.0");

    await act(async () => root.unmount());
  });

  it("renders member empty, admin fallback, connect-token error, and dialog success detection", async () => {
    const { ClientsPage } = await import("../../clients.js");

    authMock.value = {
      role: "member",
      user: { id: "user-self", username: "gandy", displayName: "Gandy", avatarUrl: null },
    };
    activityMocks.listClients.mockResolvedValueOnce([]);
    const member = await renderDom(<ClientsPage />);
    await waitForText(member.container, "No computers connected yet.");
    activityMocks.generateConnectToken.mockRejectedValueOnce(new Error("mint failed"));
    await click(exactButton(member.container, "Connect your first computer"));
    await waitForText(document.body, "mint failed");
    activityMocks.generateConnectToken.mockResolvedValueOnce({
      token: "fresh-token",
      expiresIn: 600,
      command: "first-tree-dev login fresh-token",
      bootstrapCommand: "first-tree-dev login fresh-token",
      npmSpec: null,
      binName: "first-tree-dev",
    });
    await click(exactButton(document.body, "Generate new token"));
    await waitForText(document.body, "first-tree-dev login fresh-token");
    await act(async () => member.root.unmount());

    authMock.value = {
      role: "admin",
      user: { id: "user-self", username: "gandy", displayName: "Gandy", avatarUrl: null },
    };
    activityMocks.listOrgClients.mockRejectedValueOnce(new Error("forbidden"));
    activityMocks.listClients.mockResolvedValueOnce([READY]);
    const fallback = await renderDom(<ClientsPage />);
    await waitForText(fallback.container, "Failed to load team computers");
    await waitForText(fallback.container, "gandy-macbook");
    await act(async () => fallback.root.unmount());

    activityMocks.listOrgClients.mockResolvedValueOnce([]);
    activityMocks.listClients.mockResolvedValueOnce([
      client({
        id: "client-new",
        hostname: "new-machine",
        status: "connected",
        connectedAt: new Date(Date.now() + 1000).toISOString(),
      }),
    ]);
    const emptyAdmin = await renderDom(<ClientsPage />);
    await waitForText(emptyAdmin.container, "No computers connected yet.");
    await click(exactButton(emptyAdmin.container, "Connect your first computer"));
    await waitForText(document.body, "new-machine");
    await waitForText(document.body, "connected. Closing");
    await act(async () => emptyAdmin.root.unmount());
  });
});
