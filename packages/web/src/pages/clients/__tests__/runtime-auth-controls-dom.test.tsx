// @vitest-environment happy-dom

import type { CapabilityEntry, RuntimeAuthLastError } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeAuthControls } from "../cards/shared/runtime-auth-controls.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({
  startRuntimeAuth: vi.fn(),
}));

vi.mock("../../../api/activity.js", () => ({
  startRuntimeAuth: activityMocks.startRuntimeAuth,
}));

const NOW = "2026-06-22T12:00:00.000Z";

let root: Root | null = null;
let queryClient: QueryClient | null = null;

function capability(overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  return {
    state: "ok",
    available: true,
    detectedAt: NOW,
    ...overrides,
  };
}

function lastError(overrides: Partial<RuntimeAuthLastError> = {}): RuntimeAuthLastError {
  return {
    reason: "timeout",
    at: "2026-06-22T11:55:00.000Z",
    ...overrides,
  };
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

function currentClient(): QueryClient {
  if (!queryClient) throw new Error("QueryClient was not created");
  return queryClient;
}

async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = createClient();
  queryClient = client;
  await act(async () => {
    root?.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushRealTimerNotifications(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(rootNode: ParentNode, text: string): HTMLButtonElement {
  const button = [...rootNode.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes(text),
  );
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  activityMocks.startRuntimeAuth.mockResolvedValue({ ref: "auth-ref", started: true });
  root = null;
  queryClient = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
  queryClient?.clear();
  vi.useRealTimers();
});

describe("RuntimeAuthControls", () => {
  it("renders nothing when a provider has no in-product auth affordance", async () => {
    const dom = await render(<RuntimeAuthControls clientId="client-1" provider="codex" entry={capability()} />);

    expect(dom.textContent).toBe("");
  });

  it("shows the pending browser-auth fallback link only for http URLs", async () => {
    const dom = await render(
      <RuntimeAuthControls
        clientId="client-1"
        provider="codex"
        entry={capability({
          pendingAuth: {
            method: "browser",
            expiresAt: "2999-06-22T12:05:00.000Z",
            authUrl: "https://auth.example/start",
          },
        })}
      />,
    );

    expect(dom.textContent).toContain("Waiting for you to authorize");
    expect(dom.querySelector("a")?.getAttribute("href")).toBe("https://auth.example/start");
  });

  it("hides malformed pending-auth links", async () => {
    const dom = await render(
      <RuntimeAuthControls
        clientId="client-1"
        provider="codex"
        entry={capability({
          pendingAuth: {
            method: "browser",
            expiresAt: "2999-06-22T12:05:00.000Z",
            authUrl: "not a url",
          },
        })}
      />,
    );

    expect(dom.textContent).toContain("Waiting for you to authorize");
    expect(dom.querySelector("a")).toBeNull();
  });

  it("hides non-http pending-auth links", async () => {
    const dom = await render(
      <RuntimeAuthControls
        clientId="client-1"
        provider="codex"
        entry={capability({
          pendingAuth: {
            method: "browser",
            expiresAt: "2999-06-22T12:05:00.000Z",
            authUrl: "ftp://auth.example/start",
          },
        })}
      />,
    );

    expect(dom.querySelector("a")).toBeNull();
  });

  it("starts in-product auth, latches the pending UI, and polls capabilities", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const onStarted = vi.fn();
    const dom = await render(
      <RuntimeAuthControls
        clientId="client-1"
        provider="claude-code"
        entry={capability()}
        forceConnectable={true}
        onStarted={onStarted}
      />,
    );
    const invalidate = vi.spyOn(currentClient(), "invalidateQueries");

    await click(buttonByText(dom, "Connect Claude Code"));

    expect(activityMocks.startRuntimeAuth).toHaveBeenCalledWith("client-1", { provider: "claude-code" });
    expect(dom.textContent).toContain("Waiting for you to authorize");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["clients"] });
    expect(onStarted).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(invalidate.mock.calls.filter(([arg]) => arg?.queryKey?.[0] === "clients")).toHaveLength(2);
    expect(onStarted).toHaveBeenCalledTimes(2);
  });

  it("keeps the connect affordance and shows an inline error when start fails", async () => {
    activityMocks.startRuntimeAuth.mockRejectedValue(new Error("offline"));
    const onStarted = vi.fn();
    const dom = await render(
      <RuntimeAuthControls
        clientId="client-1"
        provider="codex"
        entry={capability()}
        forceConnectable={true}
        onStarted={onStarted}
      />,
    );

    await click(buttonByText(dom, "Connect Codex"));
    await flushRealTimerNotifications();

    expect(activityMocks.startRuntimeAuth).toHaveBeenCalledWith("client-1", { provider: "codex" });
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(dom.textContent).toContain("Could not start sign-in");
    expect(dom.textContent).toContain("Connect Codex");
  });

  it.each([
    [lastError({ reason: "timeout" }), "Last sign-in timed out before it finished in the browser. Try again."],
    [lastError({ reason: "aborted" }), "Last sign-in was canceled. Try again."],
    [lastError({ reason: "exit-nonzero" }), "Last sign-in didn't complete. Try again."],
  ])("shows terminal auth failure copy %#", async (error, expected) => {
    const dom = await render(
      <RuntimeAuthControls
        clientId="client-1"
        provider="claude-code"
        entry={capability({ lastAuthError: error })}
        forceConnectable={true}
      />,
    );

    expect(dom.textContent).toContain(expected);
    expect(dom.textContent).toContain("Try Claude Code again");
  });

  it("includes truncated provider details for launch failures", async () => {
    const detail = "provider detail ".repeat(12);
    const dom = await render(
      <RuntimeAuthControls
        clientId="client-1"
        provider="claude-code"
        entry={capability({ lastAuthError: lastError({ reason: "spawn-error", message: detail }) })}
        forceConnectable={true}
      />,
    );

    expect(dom.textContent).toContain("Couldn't launch the sign-in on this computer.");
    expect(dom.textContent).toContain(detail.slice(0, 139));
    expect(dom.textContent).not.toContain(detail);
  });
});
