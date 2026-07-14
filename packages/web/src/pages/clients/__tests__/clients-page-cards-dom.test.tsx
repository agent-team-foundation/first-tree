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
const STAGING_INSTALLER_URL = "https://download.first-tree.ai/releases/staging/install.sh";
const stagingBootstrapCommand = (token: string): string =>
  `curl -fsSL ${STAGING_INSTALLER_URL} | sh\n~/.local/bin/first-tree-staging login ${token}`;
const STAGING_BOOTSTRAP_COMMAND = stagingBootstrapCommand("connect-token");
const STAGING_FRESH_BOOTSTRAP_COMMAND = stagingBootstrapCommand("fresh-token");

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
    sdkVersion,
    detectedAt: NOW,
  };
}

// "installed but logged out" is no longer a distinct capability state — detection
// is install-only, so a present-but-unauthenticated binary is simply `ok`.
function installedCapability(sdkVersion = "0.134.0"): CapabilityEntry {
  return {
    state: "ok",
    available: true,
    sdkVersion,
    detectedAt: NOW,
  };
}

function errorCapability(): CapabilityEntry {
  return {
    state: "error",
    available: false,
    sdkVersion: null,
    detectedAt: NOW,
    error: "probe failed",
  };
}

function missingCapability(): CapabilityEntry {
  return {
    state: "missing",
    available: false,
    sdkVersion: null,
    detectedAt: NOW,
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
    ...(overrides.lastUpdateAttempt !== undefined ? { lastUpdateAttempt: overrides.lastUpdateAttempt } : {}),
    hostname: overrides.hostname ?? "gandy-macbook",
    os: overrides.os ?? "darwin",
    agentCount: overrides.agentCount ?? 1,
    connectedAt: overrides.connectedAt ?? NOW,
    lastSeenAt: overrides.lastSeenAt ?? NOW,
    capabilities:
      overrides.capabilities ??
      ({
        "claude-code": okCapability(),
        codex: installedCapability(),
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
  // claude-code-tui is in DISABLED_RUNTIME_PROVIDERS, so it is filtered out of
  // PROVIDER_ORDER and never shown on the card — the errored runtime that
  // surfaces "probe failed" + a reinstall command is claude-code itself here.
  // No runtime is `ok`, so the pill stays Setup incomplete (detection is
  // install-only; codex `missing` shows its own install command).
  capabilities: {
    "claude-code": errorCapability(),
    codex: missingCapability(),
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
// Connected + OK runtime (pill = Ready) but its self-update failed — must
// surface under "Needs attention" as "Update failed", never hidden as Ready.
const TEAM_UPDATE_FAILED = client({
  id: "client-team-stuck",
  userId: "user-alice",
  hostname: "erin-stuck",
  os: "linux",
  agentCount: 2,
  lastUpdateAttempt: {
    result: "failed",
    target: "0.6.0",
    currentBefore: "0.5.0",
    installedVersion: null,
    reason: "npm E404",
    at: NOW,
  },
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
  activityMocks.listOrgClients.mockResolvedValue([
    READY,
    AUTH_EXPIRED,
    SETUP_INCOMPLETE,
    OFFLINE,
    TEAM,
    TEAM_UPDATE_FAILED,
  ]);
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
    command: "first-tree-staging login connect-token",
    bootstrapCommand: STAGING_BOOTSTRAP_COMMAND,
    installerUrl: STAGING_INSTALLER_URL,
    binName: "first-tree-staging",
  });
  memberMocks.listMembers.mockResolvedValue([
    { userId: "user-self", displayName: "Gandy" },
    { userId: "user-alice", displayName: "Alice" },
  ]);
}

beforeEach(() => {
  installBrowserStubs();
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
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
  it("renders demo mode through the page and wires scenario navigation", async () => {
    window.history.replaceState({}, "", "/settings/computers?demo=admin-grouped");
    const { ClientsPage } = await import("../../clients.js");
    const { container, root } = await renderDom(<ClientsPage />);

    await waitForText(document.body, "DEMO");
    await waitForText(container, "GandydeMacBook-Pro.local");
    await waitForText(container, "gandy-developer");

    const select = document.body.querySelector<HTMLSelectElement>('aside select[aria-label="Scenario"]');
    if (!select) throw new Error("Expected demo scenario selector");
    await act(async () => {
      select.value = "empty";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(window.location.search).toContain("demo=empty");
    await waitForText(container, "No computers connected yet.");

    await click(
      [...document.body.querySelectorAll("aside button")].find((button) => button.textContent === "Exit") ?? null,
    );
    await waitForCondition(() => !document.body.textContent?.includes("DEMO"), "Expected demo navigator to close");
    expect(window.location.search).not.toContain("demo=");

    await act(async () => root.unmount());
  });

  it("renders admin cards, team list, action dialogs, runtime commands, and connect dialog", async () => {
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
    // Setup-incomplete uses the unified "Runtimes" heading (matching Ready) with
    // single-column rows: install boxes for the missing/errored runtimes. The
    // per-card "Connect <provider>" control was removed (detection is
    // install-only — there is no logged-out state to drive a card Connect from).
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
    // A connected + Ready-runtime team machine whose self-update failed must
    // surface under "Needs attention" as "Update failed", not hidden as Ready.
    await waitForText(container, "Needs attention");
    await waitForText(container, "Update failed");
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
    await waitForText(document.body, "~/.local/bin/first-tree-staging login connect-token");
    await click(copyButtonForCommand(document.body, STAGING_BOOTSTRAP_COMMAND));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(STAGING_BOOTSTRAP_COMMAND);
    await click(exactButton(document.body, "Cancel"));

    await click(exactButton(container, "Connect"));
    await waitForText(document.body, "Connect computer");
    await click(exactButton(document.body, "Cancel"));

    await act(async () => root.unmount());
  });

  it("opens reconnect and cancels destructive computer dialogs", async () => {
    const { ClientsPage } = await import("../../clients.js");
    const { container, root } = await renderDom(<ClientsPage />);

    await waitForText(container, "offline-box");
    await click(exactButton(container, "Reconnect"));
    await waitForText(document.body, "Connect computer");
    await click(exactButton(document.body, "Cancel"));

    await click(container.querySelector('button[aria-label="Computer actions"]'));
    await click(exactButton(container, "Disconnect"));
    await waitForText(document.body, "Disconnect Computer");
    await waitForText(document.body, "No agents on this computer");
    await click(exactButton(document.body, "Cancel"));
    await waitForCondition(
      () => !document.body.textContent?.includes("Disconnect Computer"),
      "Expected disconnect dialog to close",
    );
    expect(activityMocks.disconnectClient).not.toHaveBeenCalled();

    await click(container.querySelector('button[aria-label="Computer actions"]'));
    await click(exactButton(container, "Retire"));
    await waitForText(document.body, "Retire Computer");
    await click(exactButton(document.body, "Cancel"));
    await waitForCondition(
      () => !document.body.textContent?.includes("Retire Computer"),
      "Expected retire dialog to close",
    );
    expect(activityMocks.retireClient).not.toHaveBeenCalled();

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
      command: "first-tree-staging login fresh-token",
      bootstrapCommand: STAGING_FRESH_BOOTSTRAP_COMMAND,
      installerUrl: STAGING_INSTALLER_URL,
      binName: "first-tree-staging",
    });
    await click(exactButton(document.body, "Generate new token"));
    await waitForText(document.body, "~/.local/bin/first-tree-staging login fresh-token");
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

    // issue 1353: an admin whose org-scoped view omits a client they own — e.g. the
    // computer whose agents lived in a team they just left — still sees it
    // under "Your computers" via the `/me/clients` union, so it stays
    // retirable instead of becoming invisible and undeletable.
    activityMocks.listOrgClients.mockResolvedValue([]);
    activityMocks.listClients.mockResolvedValue([client({ id: "client-mine", hostname: "my-leftover" })]);
    const ownVisible = await renderDom(<ClientsPage />);
    await waitForText(ownVisible.container, "Your computers");
    await waitForText(ownVisible.container, "my-leftover");
    await act(async () => ownVisible.root.unmount());

    // Truly-empty admin (no org rows, no own rows) still gets the empty-state
    // CTA, and a freshly-connected machine is detected and announced. The
    // dialog's one-shot poll reads `/me/clients`, so the arrival row is staged
    // before the connect click.
    activityMocks.listOrgClients.mockResolvedValue([]);
    activityMocks.listClients.mockResolvedValue([]);
    const emptyAdmin = await renderDom(<ClientsPage />);
    await waitForText(emptyAdmin.container, "No computers connected yet.");
    activityMocks.listClients.mockResolvedValue([
      client({
        id: "client-new",
        hostname: "new-machine",
        status: "connected",
        connectedAt: new Date(Date.now() + 1000).toISOString(),
      }),
    ]);
    await click(exactButton(emptyAdmin.container, "Connect your first computer"));
    await waitForText(document.body, "new-machine");
    await waitForText(document.body, "connected. Closing");
    await act(async () => emptyAdmin.root.unmount());
  });
});
