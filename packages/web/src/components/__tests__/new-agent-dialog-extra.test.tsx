// @vitest-environment happy-dom

import type { Agent } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubClient } from "../../api/activity.js";
import { ApiError, setApiSelectedOrganizationId } from "../../api/client.js";
import { ToastProvider } from "../ui/toast.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({
  getClientCapabilities: vi.fn(),
  listClients: vi.fn(),
}));

const agentMocks = vi.hoisted(() => ({
  checkAgentNameAvailability: vi.fn(),
  createAgent: vi.fn(),
}));

const clientMocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1",
    refreshMe: vi.fn(async () => undefined),
  },
}));

vi.mock("../../api/activity.js", () => activityMocks);
vi.mock("../../api/agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/agents.js")>()),
  ...agentMocks,
}));
vi.mock("../../api/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client.js")>();
  return { ...actual, api: { ...actual.api, post: clientMocks.post } };
});
vi.mock("../../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));
vi.mock("../../lib/visibility-interval.js", () => ({
  runVisibilityAwareInterval: (tick: () => void | Promise<void>) => {
    void tick();
    return () => undefined;
  },
}));

const NOW = "2026-05-28T12:00:00.000Z";

let root: Root | null = null;

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: overrides.uuid ?? "agent-created",
    name: overrides.name ?? "build-bot",
    displayName: overrides.displayName ?? "Build Bot",
    type: overrides.type ?? "agent",
    managerId: overrides.managerId ?? "member-self",
    visibility: overrides.visibility ?? "private",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
    status: overrides.status ?? "active",
    organizationId: overrides.organizationId ?? "org-1",
    delegateMention: overrides.delegateMention ?? null,
    inboxId: overrides.inboxId ?? "inbox-1",
    metadata: overrides.metadata ?? {},
    source: overrides.source ?? "portal",
    clientId: overrides.clientId ?? "client-1",
    runtimeProvider: overrides.runtimeProvider ?? "claude-code",
    runtimeState: overrides.runtimeState ?? "idle",
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function capability(state: "ok" | "missing" | "unauthenticated" | "error" = "ok") {
  return {
    state,
    available: state !== "missing",
    authenticated: state === "ok",
    sdkVersion: state === "missing" ? null : "1.0.0",
    authMethod: state === "ok" ? ("oauth" as const) : ("none" as const),
    detectedAt: NOW,
  };
}

function client(overrides: Partial<HubClient> = {}): HubClient {
  return {
    id: overrides.id ?? "client-1",
    userId: overrides.userId ?? "user-self",
    status: overrides.status ?? "connected",
    authState: overrides.authState ?? "ok",
    sdkVersion: overrides.sdkVersion ?? "0.5.0",
    hostname: overrides.hostname ?? "gandy-macbook",
    os: overrides.os ?? "darwin",
    agentCount: overrides.agentCount ?? 0,
    connectedAt: overrides.connectedAt ?? NOW,
    lastSeenAt: overrides.lastSeenAt ?? NOW,
    capabilities: overrides.capabilities ?? {
      "claude-code": capability("ok"),
      "claude-code-tui": capability("ok"),
      codex: capability("ok"),
      future: capability("ok"),
    },
  };
}

function installBrowserStubs(): void {
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("80rem"),
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
    if (container.textContent?.includes(text) || document.body.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}". Body: ${document.body.textContent ?? ""}`);
}

async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

async function renderDom(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{element}</ToastProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function blur(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  await flush();
}

function buttonByText(rootNode: ParentNode, text: string): HTMLButtonElement {
  const button = [...rootNode.querySelectorAll("button")].find((el) => el.textContent?.includes(text));
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function inputById(id: string): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`Missing input ${id}`);
  return input;
}

beforeEach(() => {
  installBrowserStubs();
  document.body.innerHTML = "";
  setApiSelectedOrganizationId("org-1");
  vi.clearAllMocks();
  vi.useRealTimers();
  activityMocks.listClients.mockResolvedValue([client(), client({ id: "client-2", hostname: "alice-linux" })]);
  activityMocks.getClientCapabilities.mockImplementation(async (clientId: string) =>
    clientId === "client-2" ? client({ id: "client-2", hostname: "alice-linux" }) : client(),
  );
  agentMocks.checkAgentNameAvailability.mockResolvedValue({ available: true });
  agentMocks.createAgent.mockResolvedValue(agent());
  clientMocks.post.mockResolvedValue({
    token: "connect-token",
    expiresIn: 600,
    command: "first-tree-dev login connect-token",
  });
  authMock.value.refreshMe.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  setApiSelectedOrganizationId(null);
  vi.useRealTimers();
});

describe("NewAgentDialog extra branches", () => {
  it("edits handle, normalizes availability states, switches computer/runtime, visibility, and submits", async () => {
    const { NewAgentDialog } = await import("../new-agent-dialog.js");
    const onCreated = vi.fn();
    const container = await renderDom(<NewAgentDialog open onOpenChange={() => undefined} onCreated={onCreated} />);

    await waitForText(container, "gandy-macbook");
    expect(document.body.textContent).toContain("Claude Code");
    await setValue(inputById("new-agent-display-name"), "Build Bot");
    await waitForCondition(() => agentMocks.checkAgentNameAvailability.mock.calls.length > 0, "Expected probe");
    await waitForText(container, "@build-bot");

    const sharedRadio = [...document.body.querySelectorAll<HTMLInputElement>('input[name="visibility"]')].find(
      (input) => input.closest("label")?.textContent?.includes("Visible to your team"),
    );
    await click(sharedRadio ?? null);
    await click(
      [...document.body.querySelectorAll<HTMLInputElement>('input[name="picked-client"]')].find((input) =>
        input.closest("label")?.textContent?.includes("alice-linux"),
      ) ?? null,
    );
    await waitForCondition(
      () => activityMocks.getClientCapabilities.mock.calls.some((call) => call[0] === "client-2"),
      "Expected second client capability fetch",
    );
    await click(
      [...document.body.querySelectorAll<HTMLInputElement>('input[name="runtime"]')].find((input) =>
        input.closest("label")?.textContent?.includes("Codex"),
      ) ?? null,
    );
    await click(buttonByText(document.body, "Create"));

    await waitForCondition(() => agentMocks.createAgent.mock.calls.length > 0, "Expected createAgent");
    expect(agentMocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "build-bot",
        displayName: "Build Bot",
        clientId: "client-2",
        runtimeProvider: "codex",
        visibility: "organization",
        organizationId: "org-1",
      }),
    );
    expect(authMock.value.refreshMe).toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ uuid: "agent-created" }), "codex");
  });

  it("surfaces client validation, server issues, root errors, and no-runtime states", async () => {
    const { NewAgentDialog } = await import("../new-agent-dialog.js");
    activityMocks.listClients.mockResolvedValue([client({ capabilities: { codex: capability("missing") } })]);
    activityMocks.getClientCapabilities.mockResolvedValue(client({ capabilities: { codex: capability("missing") } }));
    const container = await renderDom(
      <NewAgentDialog open onOpenChange={() => undefined} onCreated={() => undefined} />,
    );

    await waitForText(container, "No runtime ready");
    await setValue(inputById("new-agent-display-name"), "只会中文");
    expect(buttonByText(document.body, "Create").disabled).toBe(true);

    activityMocks.listClients.mockResolvedValue([client()]);
    activityMocks.getClientCapabilities.mockResolvedValue(client());
    await act(async () => root?.unmount());
    root = null;
    const withRuntime = await renderDom(
      <NewAgentDialog open onOpenChange={() => undefined} onCreated={() => undefined} />,
    );
    await waitForText(withRuntime, "Claude Code");

    await setValue(inputById("new-agent-display-name"), "只会中文");
    const handleInput = inputById("new-agent-name");
    await setValue(handleInput, "__Bad Name!!");
    expect(handleInput.value).toBe("bad-name-");
    await blur(handleInput);
    expect(handleInput.value).toBe("bad-name");
    await setValue(handleInput, "admin");
    await waitForText(withRuntime, "reserved");

    await act(async () => root?.unmount());
    root = null;
    const serverErrors = await renderDom(
      <NewAgentDialog open onOpenChange={() => undefined} onCreated={() => undefined} />,
    );
    await waitForText(serverErrors, "Claude Code");
    await setValue(inputById("new-agent-display-name"), "只会中文");
    await setValue(inputById("new-agent-name"), "api-bot");
    agentMocks.createAgent.mockRejectedValueOnce(
      new ApiError(400, "Validation failed", [
        { path: ["clientId"], message: "Computer is offline" },
        { path: ["unknown"], message: "Root issue" },
      ]),
    );
    await waitForText(serverErrors, "Available.");
    await click(buttonByText(document.body, "Create"));
    await waitForText(serverErrors, "Computer is offline");

    agentMocks.createAgent.mockRejectedValueOnce(new ApiError(409, "duplicate"));
    await click(buttonByText(document.body, "Create"));
    await waitForText(serverErrors, "already in use");

    await act(async () => root?.unmount());
    root = null;
    const rootError = await renderDom(
      <NewAgentDialog open onOpenChange={() => undefined} onCreated={() => undefined} />,
    );
    await waitForText(rootError, "Claude Code");
    agentMocks.createAgent.mockRejectedValueOnce(new Error("server unavailable"));
    await setValue(inputById("new-agent-display-name"), "Api Bot 2");
    await click(buttonByText(document.body, "Create"));
    await waitForText(rootError, "server unavailable");
  });

  it("handles zero-computer recovery, copy, and failed client probes", async () => {
    const { NewAgentDialog } = await import("../new-agent-dialog.js");
    activityMocks.listClients.mockRejectedValueOnce(new Error("temporary")).mockResolvedValue([]);
    activityMocks.getClientCapabilities.mockRejectedValue(new Error("capabilities down"));
    clientMocks.post.mockResolvedValueOnce({
      token: "old-token",
      expiresIn: 600,
      command: "first-tree-dev login old-token",
    });

    const container = await renderDom(
      <NewAgentDialog open onOpenChange={() => undefined} onCreated={() => undefined} />,
    );

    await waitForText(container, "No computer connected yet.");
    await waitForText(container, "first-tree-dev login old-token");
    await click(buttonByText(document.body, "Copy"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("first-tree-dev login old-token");
    expect(document.body.textContent).toContain("Copied");
  });

  it("keeps creation disabled while a name probe fails without blocking submission", async () => {
    const { NewAgentDialog } = await import("../new-agent-dialog.js");
    agentMocks.checkAgentNameAvailability.mockRejectedValueOnce(new Error("network"));
    const container = await renderDom(
      <NewAgentDialog open onOpenChange={() => undefined} onCreated={() => undefined} />,
    );

    await waitForText(container, "Claude Code");
    await setValue(inputById("new-agent-display-name"), "Probe Bot");
    await waitForCondition(() => agentMocks.checkAgentNameAvailability.mock.calls.length > 0, "Expected probe");
    expect(document.body.textContent).not.toContain("Available.");
    await click(buttonByText(document.body, "Create"));
    await waitForCondition(() => agentMocks.createAgent.mock.calls.length > 0, "Expected create after failed probe");
    expect(agentMocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({ name: "probe-bot" }));
  });
});
